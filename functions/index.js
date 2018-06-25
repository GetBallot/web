const functions = require('firebase-functions');

const admin = require('firebase-admin');
admin.initializeApp();

const ballot = require('./ballot.js');

exports.userCivicInfoWritten = functions.firestore
  .document('users/{userId}/triggers/civicinfo')
  .onWrite((change, context) => {
    if (!change.after.exists) {
      return;
    }
    const db = admin.firestore();
    const userId = context.params.userId;
    const data = change.after.data();
    const lang = data.lang;

    const electionFromVoterInfo = data.voterinfo === undefined ? null :
      ballot.compileElectionFromVoterinfo(data.voterinfo, lang);

    return ballot.compileElectionFromRepresentatives(
      db, data.representatives, lang, electionFromVoterInfo)
      .then(election => {
        return db
          .collection('users').doc(userId)
          .collection('elections').doc('upcoming')
          .set(election);
      })
  });

exports.userUpcomingElectionWritten = functions.firestore
  .document('users/{userId}/elections/upcoming')
  .onWrite((change, context) => {
    const db = admin.firestore();
    const userId = context.params.userId;

    const promises = [];

    if (change.before.exists) {
      const snap = change.before;
      const lambda = ref => 
        ref.delete();
      promises.push.apply(promises, ballot.updateUserElectionSubscriptions(db, snap, userId, lambda));
    }

    if (change.after.exists) {
      const snap = change.after;
      const lambda = ref =>
        ref.set({'creationTime': admin.firestore.FieldValue.serverTimestamp()});
      promises.push.apply(promises, ballot.updateUserElectionSubscriptions(db, snap, userId, lambda));
    }

    return Promise.all(promises);
  });

exports.electionWritten = functions.firestore
  .document('divisions/{ocd}/langs/{lang}/elections/{electionId}')
  .onWrite((change, context) => {
    return change.after.ref.collection('users').get()
      .then(querySnapshot => {
        const promises = [];

        promises.concat(ballot.copyElectionSupplement(admin.firestore(), change.after.data()));

        querySnapshot.forEach(userSnap => {
            const userId = userSnap.id;
            promises.push(admin.firestore()
              .collection('users').doc(userId)
              .collection('triggers').doc('civicinfo')
              .set({'updateUpcomingElection': admin.firestore.FieldValue.serverTimestamp()}, {merge: true}));
          });

        return Promise.all(promises);
      })
  });

exports.contestWritten = functions.firestore
  .document('divisions/{ocd}/langs/{lang}/elections/{electionDay}/contests/{contestId}')
  .onWrite((change, context) => {
    return ballot.summarizeArray(change.after.ref, context, 'contests');
  });

exports.candidateWritten = functions.firestore
  .document('divisions/{ocd}/langs/{lang}/elections/{electionDay}/contests/{contestId}/candidates/{candidateId}')
  .onWrite((change, context) => {
    return ballot.summarizeArray(change.after.ref, context, 'candidates');
  });