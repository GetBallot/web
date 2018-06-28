'use strict';

const { dialogflow, Place, Suggestions } = require('actions-on-google');
const functions = require('firebase-functions');
const uniqid = require('uniqid');
const ballot = require('./ballot.js');
const civicinfo = require('./civicinfo.js');

const admin = require('firebase-admin');
admin.initializeApp();

const app = dialogflow();

///// Google Actions

exports.dialogflowFirebaseFulfillment = functions.https.onRequest(app);

app.intent('Default Welcome Intent', (conv) => {
  if (!conv.user.storage.uniqid) {
    conv.user.storage.uniqid = uniqid('actions-');
  }
  conv.ask(new Place({
    prompt: 'What is your registered voting address? To use your home address, say, "home".',
    context: 'To get your ballot information',
  }));
});

app.intent('ask_for_place', (conv, input, place, status) => {
  // input is the raw input text
  if (place) {
    const db = admin.firestore();
    civicinfo.saveAddress(db, conv, place.formattedAddress);
    conv.ask(`<speak>
    Got it.
    <break time="1s"/>
    ${place.formattedAddress}.
    <break time="2s"/>
    To get information about the next election, say "upcoming election".
    </speak>`);
    conv.ask(new Suggestions(['upcoming election']));
  } else {
    // Possibly do something with status
    conv.close(`Sorry, I couldn't find where you are registered to vote`);
  }
});

app.intent('election_info', (conv) => {
  return civicinfo.upcomingElection(admin.firestore(), conv);
});

app.intent('voting_locations', (conv) => {
  return civicinfo.votingLocations(admin.firestore(), conv);
});

///// Cloud functions

exports.actionsAddressWritten = functions.firestore
  .document('users/{userId}/triggers/address')
  .onWrite((change, context) => {
    if (!change.after.exists) {
      return change;
    }

    const db = admin.firestore();
    const userId = context.params.userId;
    const data = change.after.data();

    return civicinfo.fetchCivicInfo(db, userId, data.lang, data.address);
});

exports.userCivicInfoWritten = functions.firestore
  .document('users/{userId}/triggers/civicinfo')
  .onWrite((change, context) => {
    if (!change.after.exists) {
      return change;
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
