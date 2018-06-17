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
    election.lang = lang;
    election.source = SOURCE_GOOGLE;

    election.election.electionDay
      = election.election.electionDay.split('-').join('');
    
    if (data.voterinfo.contests !== null) {
      data.voterinfo.contests.forEach((contest) => {
        const district = contest.district.name;

        if (contest.referendumTitle !== null) {
          contest.name = contest.referendumTitle;
        }
        if (contest.office !== null) {
          contest.name = contest.office;
        }

        const favIdPrefix = [election.election.id, district, contest.name].join('|');

        if (contest.candidates !== null) {
          contest.candidates.forEach((candidate) => {
            candidate.favId = _sanitize(favIdPrefix + '|' + candidate.name);
          });
        }

        if (contest.referendumBallotResponses !== null) {
          contest.referendumBallotResponses.forEach((response) => {
            candidate.favId = _sanitize(favIdPrefix + '|' + response);
          });
        }
      })
    }

    return _getUpcomingElectionRef(db, userId).set(election);
  });

exports.userRepresentativesWritten = functions.firestore
  .document('users/{userId}/triggers/representatives')
  .onWrite((change, context) => {
    if (!change.after.exists) {
      return;
    }

    const data = change.after.data();
    if ('updateUpcomingElection' in data) {
      const db = admin.firestore();
      const userId = context.params.userId;
      const lang = data.lang;

      return _compileElectionFromRepresentatives(db, userId, data, lang);
    }
  });

exports.userUpcomingElectionWritten = functions.firestore
  .document('users/{userId}/elections/upcoming')
  .onWrite((change, context) => {
    const userId = context.params.userId;

    const promises = [];

    if (change.before.exists) {
      const snap = change.before;
      const lambda = ref => 
        ref.delete();
      promises.concat(_updateUserElectionSubscriptions(snap, userId, lambda));
    }

    if (change.after.exists) {
      const snap = change.after;
      const lambda = ref =>
        ref.set({'creationTime': admin.firestore.FieldValue.serverTimestamp()});
      promises.concat(_updateUserElectionSubscriptions(snap, userId, lambda));
    }

    return Promise.all(promises);
  });

exports.electionWritten = functions.firestore
  .document('divisions/{ocd}/langs/{lang}/elections/{electionId}')
  .onWrite((change, context) => {
    return change.after.ref.collection('users').get()
      .then(querySnapshot => {
        const promises = [];
        querySnapshot.forEach(userSnap => {
            const userId = userSnap.id;
            promises.push(admin.firestore()
              .collection('users').doc(userId)
              .collection('triggers').doc('representatives')
              .set({'updateUpcomingElection': admin.firestore.FieldValue.serverTimestamp()}, {merge: true}));
          });
        return Promise.all(promises);
      })
  });

exports.contestWritten = functions.firestore
  .document('divisions/{ocd}/langs/{lang}/elections/{electionId}/contests/{contestId}')
  .onWrite((change, context) => {
    return _summarizeArray(change.after.ref, 'contests');
  });

exports.candidateWritten = functions.firestore
  .document('divisions/{ocd}/langs/{lang}/elections/{electionId}/contests/{contestId}/candidates/{candidateId}')
  .onWrite((change, context) => {
    return _summarizeArray(change.after.ref, 'candidates');
  });

function _summarizeArray(ref, itemsKey) {
  const collectionRef = ref.parent;
  return collectionRef.get()
    .then(querySnapshot => {
      const items = [];
      querySnapshot.forEach(itemSnap => {
        const item = itemSnap.data();
        item.id = itemSnap.ref.id;
        items.push(item);
      });
      const data = {};
      data[itemsKey] = items;
      return collectionRef.parent.set(data, {merge: true});
    });
}

function _updateUserElectionSubscriptions(snap, userId, lambda) {
  const db = admin.firestore();
  const election = snap.data();    
  const lang = election.lang;

  if (election.source === SOURCE_GOOGLE && election.election.id !== null) {
    const ref = db
      .collection('elections').doc(election.election.id)
      .collection('users').doc(userId);
    return lambda(ref);  
  }

  if ('contests' in election) {
    return election.contests
      .filter(contest => 'division' in contest)
      .map(contest => db
        .collection('divisions').doc(contest.division)
        .collection('langs').doc(lang)
        .collection('elections').doc(election.election.electionDay)
        .collection('users').doc(userId))
      .map(lambda);
  }
}

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
      election.lang = lang;
      return _getUpcomingElectionRef(db, userId).set(election);
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
       
       if ('candidates' in contest) {
         contest.candidates.map(candidate => {
           candidate.favId = _sanitize([
            upcoming.electionDay, 
            division.division, 
             contest.id,
             candidate.id].join('|'));
         });
       }

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
