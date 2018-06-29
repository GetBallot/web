'use strict';

const { Suggestions } = require('actions-on-google');
const { google } = require('googleapis');
const path = require('path');
const nconf = require('nconf');
const util = require('./util.js');

nconf.argv().env().file(path.join(__dirname, 'config.json'));

const civicinfo = google.civicinfo({
  version: 'v2',
  auth: nconf.get('api_key')
});

exports.saveAddress = function(db, conv, address) {
  const lang = util.getLang(conv.user.locale);
  return db
    .collection('users').doc(conv.user.storage.uniqid)
    .collection('triggers').doc('address')
    .set({address: address, lang: lang});
}

exports.fetchCivicInfo = function(db, userId, input) {
  const results = {lang: util.getLang(input.lang)};
  const query = {address: input.address};
  if (input.address === '1263 Pacific Ave, Kansas City, KS 66102, USA') {
    query['electionId'] = 2000;
  }
  return civicinfo.elections.voterInfoQuery(query)
    .then(res => {
      results.voterinfo = res.data;
      return res;
    })
    .catch(_ => {
      return Promise.resolve('No voter info');
    })
    .then(_ => {
      return civicinfo.representatives.representativeInfoByAddress({address: input.address})
    })
    .then(res => {
      results.representatives = res.data;
      if (input.updateUpcomingElection) {
        results.updateUpcomingElection = input.updateUpcomingElection;
      }
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
      return election;
    });
}

exports.contests = function(db, conv) {
  return db
    .collection('users').doc(conv.user.storage.uniqid)
    .collection('elections').doc('upcoming')
    .get()
    .then(snapshot => {
      const election = snapshot.exists ? snapshot.data() : null;
      _replyContests(conv, election);
      return election;
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
    conv.ask(new Suggestions(['upcoming election']));
    return election;
  }  
  if (election.election && election.election.electionDay) {
    const name = election.election.name || 'an election';
    var msg = `I found ${name} on ${_formatDate(election.election.electionDay)}.`;

    const suggestions = [];
    if (_hasVotingLocation(election)) {
      suggestions.push('voting location');
    }
    if (_hasContests(election)) {
      suggestions.push('contests');
    }
    if (suggestions.length > 0) {
      conv.ask(msg + ` To get more info, say ${_joinWith(suggestions, ', or ')}.`);
      conv.ask(new Suggestions(suggestions));
    } else {
      conv.close(msg);
    }
  } else {
    conv.close(`Sorry, I couldn't find any elections`);
  }
  return election;
}

function _replyVotingLocations(conv, election) {
  if (_hasVotingLocation(election)) {
    const location = election.votingLocations[0];
    const place = location.address.locationName || location.formattedAddress;
    conv.ask(`You can vote at ${place}.`);
  } else {
    conv.close(`Sorry, I couldn't find any voting locations`);
  }
  return election;
}

function _replyContests(conv, election) {
  if (_hasContests(election)) {
    if (election.contests.length === 1) {
      conv.ask(`There is one contest: ${election.contests[0].name}`);
    } else {
      conv.ask(`There are ${election.contests.length} contests: 
        ${_joinWith(election.contests.map(contest => contest.name), ', and ')}`);  
    }
  } else {
    conv.close(`Sorry, I couldn't find any contests`);
  }
  return election;
}


function _hasVotingLocation(election) {
  return election && election.votingLocations &&
    election.votingLocations.length > 0 &&
    election.votingLocations[0].address;
}

function _hasContests(election) {
  return election && election.contests &&
    election.contests.length > 0;
}

function _formatDate(dateStr) {
  const year = dateStr.substring(0, 4);
  const month = dateStr.substring(4, 6);
  const day = dateStr.substring(6, 8);
  return year + '-' + month + '-' + day;
}

function _joinWith(items, lastConnector) {
  if (items.length > 1) {
    return items.slice(0, -1).join(', ') + lastConnector + items.slice(-1);
  } else {
    return items.join(', ');
  }
}
