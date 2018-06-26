'use strict';

const { Suggestions } = require('actions-on-google');
const { google } = require('googleapis');
const path = require('path');
const nconf = require('nconf');

nconf.argv().env().file(path.join(__dirname, 'config.json'));

const civicinfo = google.civicinfo({
  version: 'v2',
  auth: nconf.get('api_key')
});

exports.saveAddress = function(db, conv, address) {
  const lang = conv.user.locale.split('-')[0];  
  return db
    .collection('users').doc(conv.user.storage.uniqid)
    .collection('triggers').doc('address')
    .set({address: address, lang: lang});
}

exports.fetchCivicInfo = function(db, userId, lang, address) {
  const results = {lang: lang};
  return civicinfo.elections.voterInfoQuery({address: address})
    .then(res => {
      results.voterinfo = res.data;
      return res;
    })
    .catch(_ => {
      return Promise.resolve('No voter info');
    })
    .then(_ => {
      return civicinfo.representatives.representativeInfoByAddress({address: address})
    })
    .then(res => {
      results.representatives = res.data;
      return db
        .collection('users').doc(userId)
        .collection('triggers').doc('civicinfo')
        .set(results);
    });
}

exports.upcomingElection = function(db, conv) {
  return db
    .collection('users').doc(conv.user.storage.uniqid)
    .collection('elections').doc('upcoming')
    .get()
    .then(snapshot => {
      const election = snapshot.exists ? snapshot.data() : null;
      _replyUpcomingElection(conv, election);
      return snapshot;
    });
}

exports.votingLocations = function(db, conv) {
  return db
    .collection('users').doc(conv.user.storage.uniqid)
    .collection('elections').doc('upcoming')
    .get()
    .then(snapshot => {
      const election = snapshot.exists ? snapshot.data() : null;
      _replyVotingLocations(conv, election);
      return snapshot;
    });
}

exports.formatAddressForSpeech = function(fields) {
  var address = ['line1', 'line2', 'line3', 'city', 'state']
    .map(key => fields[key])
    .filter(s => s && s.trim().length > 0)
    .join(', ')
  return address;
}

function _replyUpcomingElection(conv, election) {
  if (!election) {
    conv.ask(`Sorry, I'm still looking. Please try again in a few moments.`);
    return election;
  }  
  if (election.election && election.election.electionDay) {
    const name = election.election.name || 'an election';
    conv.ask(`I found ${name} on ${_formatDate(election.election.electionDay)}. 
      Say "voting location" to get more info.`);
    conv.ask(new Suggestions(['voting location']));
  } else {
    conv.close(`Sorry, I couldn't find any elections`);
  }
  return election;
}

function _replyVotingLocations(conv, election) {
  if (election && election.votingLocations && 
      election.votingLocations.length > 0 &&
      election.votingLocations[0].address) {
    const location = election.votingLocations[0];
    const place = location.address.locationName || location.formattedAddress;
    conv.ask(`You can vote at ${place}.`);
  } else {
    conv.close(`Sorry, I couldn't find any voting locations`);
  }
  return election;
}

function _formatDate(dateStr) {
  const year = dateStr.substring(0, 4);
  const month = dateStr.substring(4, 6);
  const day = dateStr.substring(6, 8);
  return year + '-' + month + '-' + day;
}