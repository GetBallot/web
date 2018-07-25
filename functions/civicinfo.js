'use strict';

const { Place, Suggestions } = require('actions-on-google');
const { google } = require('googleapis');
const admin = require('firebase-admin');
const path = require('path');
const nconf = require('nconf');
const uniqid = require('uniqid');
const util = require('./util.js');
const constants = require('./constants.js');

nconf.argv().env().file(path.join(__dirname, 'config.json'));

const civicinfo = google.civicinfo({
  version: 'v2',
  auth: nconf.get('api_key')
});

exports.askForPlace = function(db, conv, place) {
  if (place) {
    _saveAddress(db, conv, place.formattedAddress);
    _setConfirmContext(conv, constants.CMD_ELECTION_INFO);
    conv.ask(`<speak>
    Got it.
    <break time="1s"/>
    ${place.formattedAddress}.
    <break time="2s"/>
    Would you like to know more about the next election?
    </speak>`);
  } else {
    conv.close(`Sorry, I couldn't find where you are registered to vote.`);
  }
}

exports.clearAddress = function(db, conv, address) {
  return db
    .collection('users').doc(conv.user.storage.uniqid)
    .collection('triggers').doc('address')
    .delete()
    .then(snapshot => {
      conv.ask(`Voting address cleared.`);
      _askForPlace(conv);
      return snapshot;
    });
}

exports.fetchAddress = function(db, conv, checkingAddress) {
  if (conv.user.storage.uniqid) {
    return db
      .collection('users').doc(conv.user.storage.uniqid)
      .collection('triggers').doc('address')
      .get()
      .then(snapshot => {
        if (snapshot.exists) {
          if (checkingAddress) {
            const data = snapshot.data();
            conv.ask(`I have ${data.address}.`);
          } else {
            _setConfirmContext(conv, constants.CMD_ELECTION_INFO);
            conv.ask(`Welcome back! Would you like to hear about the next election?`);
          }
        } else {
          _askForPlace(conv, checkingAddress);
        }
        return snapshot;
      })
      .then(snapshot => {
        if (snapshot.exists) {
          const data = snapshot.data();
          data['updateUpcomingElection'] = admin.firestore.FieldValue.serverTimestamp();
          return snapshot.ref.set(data);
        } else {
          return snapshot;
        }
      });
  } else {
    conv.user.storage.uniqid = uniqid('actions-');
    _askForPlace(conv, checkingAddress);
  }
}

exports.changeAddress = function(conv) {
  _askForPlace(conv);
}

function _saveAddress(db, conv, address) {
  const lang = util.getLang(conv.user.locale);
  return db
    .collection('users').doc(conv.user.storage.uniqid)
    .collection('triggers').doc('address')
    .set({address: address, lang: lang});
}

function _askForPlace(conv, checkingAddress) {
  if (checkingAddress) {
    conv.ask(`Sorry I do not know your address.`);
  }
  conv.ask(new Place({
    prompt: 'What is your registered voting address?',
    context: 'To get your ballot information',
  }));
}

exports.fetchCivicInfo = function(db, userId, input) {
  const results = {lang: util.getLang(input.lang)};
  const query = {address: input.address};
  if (input.address.startsWith('1263 Pacific Ave') &&
      input.address.includes('Kansas City, KS')) {
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
      return civicinfo.representatives.representativeInfoByAddress({
        address: input.address,
        includeOffices: false
      });
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

exports.bye = function(conv) {
  conv.close(`Thank you for using Ballot Guide. Remember to vote!`);
}

exports.help = function(db, conv) {
  return db
    .collection('users').doc(conv.user.storage.uniqid)
    .collection('elections').doc('upcoming')
    .get()
  .then(snapshot => {
    const election = snapshot.exists ? snapshot.data() : null;
    _help(conv, election);
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
    conv.ask(`Sorry, I'm still looking. 
      Please try again by saying 'upcoming election' in a few moments.`);
    conv.ask(new Suggestions(['upcoming election']));
    return election;
  }  
  if (election.election && election.election.electionDay) {
    const name = election.election.name || 'an election';
    const msg = `I found ${name} on ${_formatDate(election.election.electionDay)}.`;
    _ask(conv, election, msg, constants.CMD_ELECTION_INFO);
  } else {
    conv.close(`Sorry, I couldn't find any elections.`);
  }
  return election;
}

function _replyVotingLocations(conv, election) {
  if (_hasVotingLocation(election)) {
    const location = election.votingLocations[0];
    const place = location.address.locationName || location.formattedAddress;
    const msg = `You can vote at ${place}.`;
    _ask(conv, election, msg, constants.CMD_VOTING_LOCATION);
  } else {
    const msg = `Sorry, I couldn't find any voting locations.`;
    _ask(conv, election, msg, constants.CMD_VOTING_LOCATION);
  }
  return election;
}

function _replyContests(conv, election) {
  var msg = `Sorry, I couldn't find any contests.`;
  if (_hasContests(election)) {
    if (election.contests.length === 1) {
      msg = `There is one contest: ${election.contests[0].name}.`;
    } else {
      msg = `There are ${election.contests.length} contests: 
        ${_joinWith(election.contests.map(contest => contest.name), ', and ')}`;  
    }
  }

  _ask(conv, election, msg, constants.CMD_CONTESTS);

  return election;
}

function _help(conv, election) {
  const suggestions = _getElectionSuggestions(election);

  if (suggestions.length > 0) {
    conv.ask(`Try ${_joinWith(suggestions, ', or ')}?`);
  }
}

function _ask(conv, election, msg, currentCmd) {
  const suggestions = _getElectionSuggestions(election);
  const nextCmd = _getNextCommand(suggestions, currentCmd);

  if (suggestions.length > 0) {
    if (nextCmd) {
      _setConfirmContext(conv, nextCmd);
    } else {
      _setConfirmContext(conv, constants.CMD_ELECTION_INFO);
    }
    const suffix = nextCmd ? `Would you like to know more about ${nextCmd}?` :
      `Would you like to hear about ${_joinWith(suggestions, ', or ')}?`;
    conv.ask(`<speak>
    ${msg}
    <break time="1s"/>
    ${suffix}
    </speak>`); 
    conv.ask(new Suggestions(suggestions));
  } else {
    conv.close(`${msg}. Don't forget to vote!`);
  }
}

function _setContext(conv, context, num, params) {
  const sanitized = context.split(' ').join('-');
  conv.contexts.set(sanitized, num, params);
}

function _setConfirmContext(conv, context) {
  _setContext(conv, `${context}-confirm`, 1, {});
}

function _getNextCommand(suggestions, currentCmd) {
  var index = -1;
  suggestions.forEach((suggestion, i) => {
    if (suggestion === currentCmd) {
      index = i + 1;
    }
  });
  if (index >= 0 && index < suggestions.length) {
    return suggestions[index];
  }
  return null;
}

function _getElectionSuggestions(election) {
  const suggestions = [ constants.CMD_ELECTION_INFO ];
  if (_hasVotingLocation(election)) {
    suggestions.push(constants.CMD_VOTING_LOCATION);
  }
  if (_hasContests(election)) {
    suggestions.push(constants.CMD_CONTESTS);
  }
  return suggestions;
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
