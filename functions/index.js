const functions = require('firebase-functions');

const admin = require('firebase-admin');
admin.initializeApp();

const SOURCE_BALLOT = 'getballot.com';

exports.userRepresentativesWritten = functions.firestore
  .document('users/{userId}/triggers/representatives')
  .onWrite((change, context) => {
    if (!change.after.exists) {
      return;
    }
    const db = admin.firestore();
    const data = change.after.data();
    const lang = data.lang;

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
        return db
          .collection('users').doc(context.params.userId)
          .collection('elections').doc('upcoming')
          .set(election);
      });
  });

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

function _sanitize(ocd) {
  return ocd.split('/').join(',')
}