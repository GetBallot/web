'use strict';

const { dialogflow, Suggestions } = require('actions-on-google');
const functions = require('firebase-functions');
const ballot = require('./ballot.js');
const civicinfo = require('./civicinfo.js');
const util = require('./util.js');

const admin = require('firebase-admin');
admin.initializeApp();

const app = dialogflow();

///// Google Actions

exports.dialogflowFirebaseFulfillment = functions.https.onRequest(app);

app.intent('welcome', (conv) => {
  const db = admin.firestore();
  return civicinfo.fetchAddress(db, conv, false);
});

app.intent('change_address', (conv) => {
  return civicinfo.changeAddress(conv);
});

app.intent('check_address', (conv) => {
  const db = admin.firestore();
  return civicinfo.fetchAddress(db, conv, true);
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

app.intent('contests', (conv) => {
  return civicinfo.contests(admin.firestore(), conv);
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
    const after = change.after.data();

    return civicinfo.fetchCivicInfo(db, userId, after);
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
    const lang = util.getLang(data.lang);

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