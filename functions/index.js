
'use strict';

const { dialogflow, Suggestions } = require('actions-on-google');
const functions = require('firebase-functions');
const ballot = require('./ballot.js');
const civicinfo = require('./civicinfo.js');
const util = require('./util.js');
const constants = require('./constants.js');

const admin = require('firebase-admin');
admin.initializeApp();

const path = require('path');
const nconf = require('nconf');

nconf.argv().env().file(path.join(__dirname, 'config.json'));

const app = dialogflow({
  clientId: nconf.get('clientId')
});

///// Google Actions

exports.dialogflowFirebaseFulfillment = functions.https.onRequest(app);

app.intent('welcome', (conv) => {
  return civicinfo.fetchAddress(admin.firestore(), conv, false);
});

app.intent('welcome - yes', (conv) => {
  return civicinfo.upcomingElection(admin.firestore(), conv);
});

app.intent('change-address', (conv) => {
  return civicinfo.changeAddress(conv);
});

app.intent('check-address', (conv) => {
  return civicinfo.fetchAddress(admin.firestore(), conv, true);
});

app.intent('clear-address', (conv) => {
  return civicinfo.clearAddress(admin.firestore(), conv, true);
});

app.intent('ask-for-place', (conv, input, place, status) => {
  return civicinfo.askForPlace(admin.firestore(), conv, place);
});

app.intent('election-info', (conv) => {
  return civicinfo.upcomingElection(admin.firestore(), conv);
});
app.intent('election-info - confirm', (conv) => {
  return civicinfo.upcomingElection(admin.firestore(), conv);
});
app.intent('election-info - no', (conv) => {
  return civicinfo.bye(conv);
});

app.intent('voting-location', (conv) => {
  return civicinfo.votingLocations(admin.firestore(), conv);
});
app.intent('voting-location - confirm', (conv) => {
  return civicinfo.votingLocations(admin.firestore(), conv);
});
app.intent('voting-location - no', (conv) => {
  return civicinfo.bye(conv);
});

app.intent('contests', (conv) => {
  return civicinfo.contests(admin.firestore(), conv);
});
app.intent('contests - confirm', (conv) => {
  return civicinfo.contests(admin.firestore(), conv);
});
app.intent('contests - no', (conv) => {
  return civicinfo.bye(conv);
});

app.intent('bye', (conv) => {
  return civicinfo.bye(conv);
});

app.intent('help', (conv) => {
  return civicinfo.help(admin.firestore(), conv);
});

///// Cloud functions

exports.actionsAddressWritten = functions.firestore
  .document('users/{userId}/triggers/address')
  .onWrite((change, context) => {
    const db = admin.firestore();
    const userId = context.params.userId;

    if (!change.after.exists) {
      return db
        .collection('users').doc(userId)
        .collection('triggers').doc('civicinfo')
        .delete();
    }

    const after = change.after.data();

    return civicinfo.fetchCivicInfo(db, userId, after);
});

exports.userCivicInfoWritten = functions.firestore
  .document('users/{userId}/triggers/civicinfo')
  .onWrite((change, context) => {
    const db = admin.firestore();
    const userId = context.params.userId;

    if (!change.after.exists) {
      return db
        .collection('users').doc(userId)
        .collection('elections').doc('upcoming')
        .delete();
    }

    const data = change.after.data();
    const lang = util.getLang(data.lang);

    if (!change.after.exists) {
      return db
        .collection('users').doc(userId)
        .collection('elections').doc('upcoming')
        .delete();
    }

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