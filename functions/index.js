
'use strict';

const { dialogflow, Suggestions } = require('actions-on-google');
const functions = require('firebase-functions');
const ballot = require('./ballot.js');
const civicinfo = require('./civicinfo.js');
const util = require('./util.js');
const constants = require('./constants.js');

const admin = require('firebase-admin');
admin.initializeApp();

const db = admin.firestore();
const settings = { timestampsInSnapshots: true };
db.settings(settings);

const path = require('path');
const nconf = require('nconf');

nconf.argv().env().file(path.join(__dirname, 'config.json'));

const app = dialogflow({
  clientId: nconf.get('clientId')
});

///// Google Actions

exports.dialogflowFirebaseFulfillment = functions.https.onRequest(app);

app.intent('fallback', (conv, params) => {
  civicinfo.init(conv, 'fallback');
  return civicinfo.fallback(db, conv, params);
});

app.intent('welcome', (conv) => {
  civicinfo.init(conv, 'welcome');
  return civicinfo.fetchAddress(db, conv, false);
});

app.intent('welcome - yes', (conv) => {
  return civicinfo.upcomingElection(db, conv);
});

app.intent('change-address', (conv) => {
  return civicinfo.changeAddress(conv);
});
app.intent('change-address - confirm', (conv, params, confirmationGranted) => {
  if (confirmationGranted) {
    return civicinfo.changeAddress(conv);
  } else {
    return civicinfo.bye(db, conv);
  }
});

app.intent('check-address', (conv) => {
  return civicinfo.fetchAddress(db, conv, true);
});

app.intent('clear-address', (conv) => {
  return civicinfo.clearAddress(db, conv, true);
});

app.intent('ask-for-place', (conv, input, place, status) => {
  return civicinfo.askForPlace(db, conv, place);
});

app.intent('election-info', (conv) => {
  return civicinfo.upcomingElection(db, conv);
});
app.intent('election-info - confirm', (conv) => {
  return civicinfo.upcomingElection(db, conv);
});
app.intent('election-info - contest', (conv, params) => {
  return civicinfo.contest(db, conv, params);
});

app.intent('voting-location', (conv) => {
  return civicinfo.votingLocations(db, conv);
});
app.intent('voting-location - confirm', (conv) => {
  return civicinfo.votingLocations(db, conv);
});
app.intent('voting-location - no', (conv) => {
  return civicinfo.bye(db, conv);
});

app.intent('contests', (conv) => {
  return civicinfo.contests(db, conv);
});
app.intent('contests - confirm', (conv) => {
  return civicinfo.contests(db, conv);
});
app.intent('contests - no', (conv) => {
  return civicinfo.bye(db, conv);
});
app.intent('contests-list', (conv) => {
  return civicinfo.contestsAll(db, conv);
});
app.intent('contests - all', (conv) => {
  return civicinfo.contestsAll(db, conv);
});

app.intent('contest', (conv, params) => {
  civicinfo.init(conv, 'contest');
  return civicinfo.contest(db, conv, params);
});
app.intent('contest - which', (conv, params) => {
  return civicinfo.contestWhich(db, conv, params);
});

app.intent('candidate', (conv, params) => {
  civicinfo.init(conv, 'candidate');
  return civicinfo.candidate(db, conv, params);
});
app.intent('candidate - in contest', (conv, params) => {
  return civicinfo.candidateInContest(db, conv, params);
});
app.intent('candidate - in contest - fallback', (conv, params) => {
  return civicinfo.candidateInContest(db, conv, params);
});
app.intent('candidate - in contest - none', (conv) => {
  return civicinfo.bye(db, conv);
});

app.intent('choice-by-ordinal', (conv, params) => {
  return civicinfo.choiceByOrdinal(db, conv, params);
});
app.intent('choice-by-party', (conv, params) => {
  return civicinfo.choiceByParty(db, conv, params);
});
app.intent('choice - confirm', (conv, params) => {
  return civicinfo.choiceConfirm(db, conv, params);
});

app.intent('trigger-query - confirm', (conv, params) => {
  return civicinfo.triggerQuery(db, conv, params);
});

app.intent('bye', (conv) => {
  return civicinfo.bye(db, conv);
});
app.intent('actions.intent.CANCEL', (conv) => {
  return civicinfo.bye(db, conv);
});

app.intent('help', (conv) => {
  return civicinfo.help(db, conv);
});

///// Cloud functions

exports.actionsAddressWritten = functions.firestore
  .document('users/{userId}/triggers/address')
  .onWrite((change, context) => {
    const userId = context.params.userId;

    if (!change.after.exists) {
      const promises = [];
      promises.push(db
        .collection('users').doc(userId)
        .collection('triggers').doc('civicinfo')
        .delete());
      promises.push(db
        .collection('users').doc(userId)
        .collection('triggers').doc('voterinfo')
        .delete());
      return Promise.all(promises);
    }

    const after = change.after.data();
    return db
      .collection('users').doc(userId)
      .collection('elections').doc('upcoming')
      .delete()
      .then(_ => civicinfo.fetchCivicInfo(db, userId, after));
});

exports.userVoterInfoWritten = functions.firestore
  .document('users/{userId}/triggers/voterinfo')
  .onWrite((change, context) => {
    const userId = context.params.userId;

    if (!change.after.exists) {
      return change;
    }

    const data = change.after.data();
    const lang = util.getLang(data.lang);

    const electionFromVoterInfo = data && data.voterinfo ?
      ballot.compileElectionFromVoterinfo(data.voterinfo, data.address, lang) : null;

    if (electionFromVoterInfo) {
      const promises = [];
      if (electionFromVoterInfo.election) {
        promises.push(db
          .collection('users').doc(userId)
          .collection('elections').doc('upcoming')
          .set(electionFromVoterInfo));
      }
      promises.push(db
        .collection('users').doc(userId)
        .collection('elections').doc('fromVoterInfo')
        .set(electionFromVoterInfo));
      return Promise.all(promises);
    } else {
      return change;
    }
  });

exports.userCivicInfoWritten = functions.firestore
  .document('users/{userId}/triggers/civicinfo')
  .onWrite((change, context) => {
    const userId = context.params.userId;

    if (!change.after.exists) {
      return db
        .collection('users').doc(userId)
        .collection('elections').doc('fromRepresentatives')
        .delete();
    }

    const data = change.after.data();
    const lang = util.getLang(data.lang);

    const electionFromRepresentatives =
      ballot.compileElectionFromRepresentatives(db, data.representatives, data.address, lang);

    return ballot.mergeElectionFromRepresentatives(db, userId, electionFromRepresentatives)
      .then(election => {
        const promises = [];
        if (election.election || election.source === constants.SOURCE_BALLOT) {
          promises.push(db
            .collection('users').doc(userId)
            .collection('elections').doc('upcoming')
            .set(election));
        }
        promises.push(db
          .collection('users').doc(userId)
          .collection('elections').doc('fromRepresentatives')
          .set(election));
        return Promise.all(promises);
      });
  });

  exports.userElectionFromVoterInfoWritten = functions.firestore
    .document('users/{userId}/elections/fromVoterInfo')
    .onWrite((change, context) => {
      if (!change.after.exists) {
        return change;
      }

      const userId = context.params.userId;
      const electionFromVoterInfo = change.after.data();

      return ballot.mergeElectionFromVoterInfo(db, userId, electionFromVoterInfo)
        .then(election => {
          if (election && election.election) {
            return db
              .collection('users').doc(userId)
              .collection('elections').doc('upcoming')
              .set(election);
          } else {
            return election;
          }
        });
    });
