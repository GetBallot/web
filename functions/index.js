const functions = require('firebase-functions');

const admin = require('firebase-admin');
admin.initializeApp();

const SOURCE_GOOGLE = 'civicinfo#voterInfoResponse';
const SOURCE_BALLOT = 'getballot.com';

exports.userVoterInfoWritten = functions.firestore
  .document('users/{userId}/triggers/voterinfo')
  .onWrite((change, context) => {
    if (!change.after.exists) {
      return;
    }
    const db = admin.firestore();
    const userId = context.params.userId;
    const data = change.after.data();
    const lang = data.lang;

    const election = data.voterinfo;
    election['source'] = SOURCE_GOOGLE;

    election.election['electionDay']
      = election.election['electionDay'].split('-').join('');

    const promises = [];
    
    data.voterinfo.contests.forEach((contest) => {
      var division = null;
      if (contest.district !== null) {
        division = contest.district.name;
      }
      if (contest.level !== null && contest.level.length > 0) {
        division = contest.level[0];
      }

      if (contest.referendumTitle !== null) {
        contest['name'] = contest.referendumTitle;
      }
      if (contest.office !== null) {
        contest['name'] = contest.office;
      }

      if (division !== null && contest.name !== null) {
        contest['divisionContest'] = _sanitize(division + '|' + contest.name);
        promises.push(_createDivisionContest(db, user, contest));
      }
    })

    promises.unshift(_getUpcomingElectionRef(db, userId).set(election));

    return Promise.all(promises);  
  });

exports.userRepresentativesWritten = functions.firestore
  .document('users/{userId}/triggers/representatives')
  .onWrite((change, context) => {
    if (!change.after.exists) {
      return;
    }

    const data = change.after.data();
    if (!data.updateUpcomingElection) {
      return;
    }

    const db = admin.firestore();
    const userId = context.params.userId;
    const lang = data.lang;

    return _compileElectionFromRepresentatives(db, userId, data, lang);
  });

exports.contestWritten = functions.firestore
  .document('divisions/{ocd}/langs/{lang}/elections/{electionId}/contests/{contestId}')
  .onWrite((change, context) => {
    const db = admin.firestore();
    const collectionRef = change.after.ref.parent;    
  
    return collectionRef.get()
      .then(querySnapshot => {
        const contests = [];
        querySnapshot.forEach(contestSnap => {
          const contest = contestSnap.data();
          contest.id = contestSnap.ref.id;
          contests.push(contest);
        });
        return collectionRef.parent.set({'contests': contests}, {merge: true});
      });
  });

function _compileElectionFromRepresentatives(db, userId, data, lang) {
  const promises = [];
  for (var ocd in data.representatives.divisions) {
    promises.push(_getElectionPromise(db, lang, ocd));
  }

  return Promise.all(promises)
    .then(divisionsSnap => {
      const divisions = [];
      divisionsSnap.forEach(electionsSnap => {
        if (!electionsSnap.empty) {
          electionsSnap.forEach(electionSnap => {
            if (electionSnap.exists) {
              const data = electionSnap.data();
              data.division = electionSnap.ref.parent.parent.parent.parent.id;
              divisions.push(data);
            }
          });
        }
      })
      const election = _filterUpcomingElection(data.representatives.input, divisions);
      return _getUpcomingElectionRef(db, userId)
        .set(election);
    });
}

function _filterUpcomingElection(input, divisions) {
  const election = {input: input, source: SOURCE_BALLOT}

  // Find the earliest electionDay
  const upcoming = divisions.reduce((prev, curr) =>
    (prev === null || prev.electionDay > curr.electionDay) ? curr : prev,
  null);

  if (upcoming === null) {
    return election;
  }

  // Keep only the contests from the earliest electionDay
  // Sort by division
  // Flatten
  const contests = divisions
    .filter(division => division.electionDay === upcoming.electionDay)
    .sort((a, b) => String(a.division).localeCompare(b.division))
    .map(division => division.contests.map(contest => {
       contest.division = division.division;
       return contest
    }))
    .reduce((acc, val) => acc.concat(val), []);

  election.election = {
    electionDay: upcoming.electionDay,
    name: upcoming.name
  };
  election.contests = contests;

  return election;
}

function _getElectionPromise(db, lang, ocd) {
  const sanitizedOcd = _sanitize(ocd);
  return db
    .collection('divisions').doc(sanitizedOcd)
    .collection('langs').doc(lang)
    .collection('elections')
    .where('electionDay', '>=', _today())
    .orderBy('electionDay')
    .limit(1)
    .get();
}

function _getUpcomingElectionRef(db, userId) {
  return db
    .collection('users').doc(userId)
    .collection('elections').doc('upcoming');
}

function _createDivisionContest(db, userId, contest) {
  return _getUpcomingElectionRef(db, userId)
    .collection('contests').doc(contest.divisionContest)
    .set(contest);
}

function _today() {
  var today = new Date();
  var dd = today.getDate();
  var mm = today.getMonth() + 1;
  var yyyy = today.getFullYear();

  if (dd < 10) {
    dd = '0' + dd
  }

  if (mm < 10) {
    mm = '0' + mm
  }

  return yyyy + '' + mm + '' + dd;
}

function _sanitize(id) {
  return id.split('/').join(',')
}
