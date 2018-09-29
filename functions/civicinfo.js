'use strict';

const { Place, Button, Confirmation, BasicCard, Suggestions } = require('actions-on-google');
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

exports.init = function(conv, intent) {
  if (!conv.data.version) {
    const key = Object.keys(conv.contexts.input)
      .find(key => key.indexOf('version-') === 0);
    conv.data.version = key ? parseInt(key.substring(8)): 3;
  }

  const query = conv.arguments.parsed.input.trigger_query;
  if (query) {
    conv.data.query = {
      intent: intent,
      text: query
    };
  }
}

exports.askForPlace = function(db, conv, place) {
  if (!place) {
    conv.close(`Sorry, I couldn't find where you are registered to vote.`);
    return Promise.resolve();
  }

  _saveAddress(db, conv, place.formattedAddress);

  // TODO: Direct look up if conv.data.query is defined

  _setConfirmContext(conv, constants.CMD_ELECTION_INFO);
  conv.contexts.set(constants.CMD_FETCH_ELECTION, 3, {});
  conv.ask(`<speak>
    Got it.
    <break time="1s"/>
    ${place.formattedAddress}.
    <break time="2s"/>
    Now I will use your voting address to find out what's on your ballot. Give me a few moments, alright?
  </speak>`);
  return Promise.resolve();
}

exports.clearAddress = function(db, conv, address) {
  return db
    .collection('users').doc(conv.user.storage.uniqid)
    .collection('triggers').doc('address')
    .delete()
    .then(snapshot => {
      conv.ask(`Voting address cleared.`);
      _askForPlace(conv, false);
      return snapshot;
    });
}

exports.saveVersion = function(conv) {
  const key = Object.keys(conv.contexts.input)
    .find(key => key.indexOf('version-') === 0)
  conv.data.version = key ? parseInt(key.substring(8)): 3;
}

exports.fetchAddress = function(db, conv, checkingAddress) {
  if (!conv.user.storage.uniqid) {
    conv.user.storage.uniqid = uniqid('actions-');
    _askForPlace(conv, false);
    return Promise.resolve();
  }

  var hasAddress = false;
  return db
    .collection('users').doc(conv.user.storage.uniqid)
    .collection('triggers').doc('address')
    .get()
    .then(snapshot => {
      if (snapshot.exists) {
        hasAddress = true;
        if (checkingAddress) {
          const data = snapshot.data();
          conv.ask(`I have ${data.address}. Anything else?`);
          conv.ask(new Suggestions(['help']));
          return Promise.resolve();
        } else {
          const modifiedAt = snapshot.get('updateUpcomingElection');
          const now = new Date();

          // Update upcoming election if older than 12 hours (43200000 ms)
          const shouldUpdate = modifiedAt ? now - modifiedAt.toDate() > 43200000 : true;
          if (shouldUpdate) {
            const data = snapshot.data();
            data['updateUpcomingElection'] = admin.firestore.FieldValue.serverTimestamp();
            return snapshot.ref.set(data);
          }

          return db
            .collection('users').doc(conv.user.storage.uniqid)
            .collection('elections').doc('upcoming')
            .get();
        }
      } else {
        _askForPlace(conv, checkingAddress);
        return Promise.resolve();
      }
    })
    .then(snapshot => {
      if (checkingAddress || !hasAddress) {
        return Promise.resolve();
      }

      const election = snapshot && snapshot.exists ? snapshot.data() : null;
      const query = conv.data.query;
      if (election) {
        if (!query ||
            !_genericSearch(conv, election, conv.input.raw, { query: query.text })) {
        _replyUpcomingElection(conv, election, 'Your next election is', true);
        }
      } else {
        if (query && conv.data.version >= 6) {
          conv.contexts.set(constants.CMD_TRIGGER_QUERY, 5, { query: query.text } );
          conv.ask(new Confirmation(`Let me go fetch the information for ${query.text}. Give me a moment, alright?`));
        } else {
          _setConfirmContext(conv, constants.CMD_ELECTION_INFO);
          conv.ask(`Welcome back! Let me go fetch your ballot information. Give me a moment, alright?`);
          conv.ask(new Suggestions(['okay']));
        }
      }
      return Promise.resolve();
    });
}

exports.changeAddress = function(conv) {
  _askForPlace(conv, false);
}

function _saveAddress(db, conv, address) {
  const lang = util.getLang(conv.user.locale);
  conv.user.storage.address = address;
  return db
    .collection('users').doc(conv.user.storage.uniqid)
    .collection('triggers').doc('address')
    .set({
      address: address,
      lang: lang,
      updateUpcomingElection: admin.firestore.FieldValue.serverTimestamp()
    });
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
  const results = {lang: util.getLang(input.lang), address: input.address};
  const query = {address: input.address};
  if (input.address.startsWith('1263 Pacific Ave') &&
      input.address.includes('Kansas City, KS')) {
    query['electionId'] = 2000;
  }

  return Promise.all([
    civicinfo.elections.voterInfoQuery(query)
      .then(res => {
       results.voterinfo = res.data;
       return db
         .collection('users').doc(userId)
         .collection('triggers').doc('voterinfo')
         .set(results);
     })
      .catch(_ => {
        const election = {
          lang: results.lang,
          address: results.address,
          source: constants.SOURCE_GOOGLE
        };
        const promises = [];
        promises.push(db
          .collection('users').doc(userId)
          .collection('elections').doc('fromVoterInfo')
          .set(election));
        promises.push(db
          .collection('users').doc(userId)
          .collection('triggers').doc('voterinfo')
          .delete());
        return Promise.all(promises);
    }),
    civicinfo.representatives.representativeInfoByAddress({
      address: input.address,
      includeOffices: false
    }).then(res => {
      results.representatives = res.data;
      if (input.updateUpcomingElection) {
        results.updateUpcomingElection = input.updateUpcomingElection;
      }
      return db
        .collection('users').doc(userId)
        .collection('triggers').doc('civicinfo')
        .set(results);
    })
  ]);
}

exports.fetchElections = function(db) {
  var filtered = [];
  var civicElections = null;
  return db
    .collection('elections').doc('all')
    .get()
    .then(snapshot => {
      const elections = snapshot.exists ? snapshot.data() : null;
      const modifiedAt = elections ? elections.modifiedAt : null;
      const now = new Date();

      // Fetch elections if older than 3 hours (10800000 ms)
      const shouldUpdate = modifiedAt ? now - modifiedAt.toDate() > 10800000 : true;
      if (!shouldUpdate) {
        return Promise.resolve();
      }

      return civicinfo.elections.electionQuery();
    })
    .then(res => {
      if (!res) {
        return Promise.resolve();
      }

      civicElections = res.data;
      const elections = civicElections ? civicElections.elections : null;

      filtered = elections
        .filter(election =>
          election.id !== '2000' && election.name && election.electionDay && election.ocdDivisionId);

      const promises = filtered
        .map(election => {
          const electionDay = election.electionDay.split('-').join('');
          return db
            .collection('divisions').doc(util.sanitize(election.ocdDivisionId))
            .collection('langs').doc('en')
            .collection('elections').doc(electionDay)
            .get();
        })

      return Promise.all(promises);
    })
    .then(snapshots => {
      if (!snapshots) {
        return Promise.resolve();
      }
      const existing = snapshots
        .filter(snapshot => snapshot.exists)
        .map(snapshot => snapshot.data().id);

      const promises = filtered
        .filter(election => !existing.includes(election.id))
        .map(election => {
          const electionDay = election.electionDay.split('-').join('');
          return db
            .collection('divisions').doc(util.sanitize(election.ocdDivisionId))
            .collection('langs').doc('en')
            .collection('elections').doc(electionDay)
            .set({
              id: election.id,
              name: election.name,
              electionDay: electionDay,
              modifiedAt: admin.firestore.FieldValue.serverTimestamp()
            });
        });

      return Promise.all(promises);
    })
    .then(_ => {
      if (civicElections) {
        civicElections.modifiedAt =  admin.firestore.FieldValue.serverTimestamp();
        return db
          .collection('elections').doc('all')
          .set(civicElections);
      }
      return Promise.resolve();
    });
}

exports.upcomingElection = function(db, conv) {
  return db
    .collection('users').doc(conv.user.storage.uniqid)
    .collection('elections').doc('upcoming')
    .get()
    .then(snapshot => {
      const election = snapshot.exists ? snapshot.data() : null;
      _replyUpcomingElection(conv, election, 'I found', false);
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
      _replyContestsSummary(conv, election);
      return election;
    });
}

exports.contestsAll = function(db, conv) {
  return db
    .collection('users').doc(conv.user.storage.uniqid)
    .collection('elections').doc('upcoming')
    .get()
    .then(snapshot => {
      const election = snapshot.exists ? snapshot.data() : null;
      _replyContestsAll(conv, election);
      return Promise.resolve();
    });
}

exports.contest = function(db, conv, params) {
  if (!conv.user.storage.uniqid) {
    conv.user.storage.uniqid = uniqid('actions-');
    _askForPlace(conv, false);
    return Promise.resolve();
  }

  if (conv.data.query && !params.query) {
    params.query = conv.data.query.text;
  }

  return db
    .collection('users').doc(conv.user.storage.uniqid)
    .collection('elections').doc('upcoming')
    .get()
    .then(snapshot => {
      const election = snapshot.exists ? snapshot.data() : null;
      const input = conv.input.raw;
      const contests = election && election.contests ? _findContests(election.contests, input, params) : [];
      if (contests.length === 0) {
        const query = [
          params ? params.candidate : null,
          params ? params.query : null,
          input
        ].find(q => q);
        conv.ask(`Sorry I didn't find ${query} on your ballot.`);
        conv.ask(new Suggestions(['help']));
      } else {
        _replyContests(conv, contests);
      }
      return Promise.resolve();
    });
}

function _replyContests(conv, contests) {
  if (contests.length === 1) {
    _askCandidatesInContest(conv, contests[0]);
  }
  if (contests.length > 1) {
    conv.contexts.set(constants.CMD_CONTEST_WHICH, 2, {
      contests: contests.map(contest => contest.index)
    });

    conv.contexts.set(constants.CMD_CHOICES, 1, {
      contests: contests.map(contest => contest.index)
    });

    const names = contests.map(contest => contest.name);
    conv.ask(`I found ${_joinWith(names, ', and ')}. ${_whichOne('contest')}`);
  }
}

function _askCandidatesInContest(conv, contest) {
  const candidates = contest.candidates || [];
  if (candidates.length === 0) {
    conv.ask(`${contest.name} has no candidates. Any other contest you want to learn more about?`);
    return;
  }
  if (candidates.length === 1) {
    const desc = _describeCandidate(conv, contest, candidates[0]);
    conv.ask(`${desc[0]} That is the only candidate. Anything else?`);
    return;
  }
  conv.contexts.set(constants.CMD_CANDIDATE_IN_CONTEST, 2, {
    contest: contest.index
  });
  conv.contexts.set(constants.CMD_CHOICES, 1, {
    contest: contest.index,
    candidates: contest.candidates.map((_, index) => index)
  });

  const names = contest.candidates.map(candidate => candidate.name);
  conv.ask(`${contest.name} has ${candidates.length} candidates: ${_joinWith(names, ', and ')}. ${_whichOne('candidate')}`);
  _showSuggestions(conv, names);
}

function _showSuggestions(conv, choices) {
  if (!choices || choices.length === 0 || choices.length > 8) {
    return;
  }
  if (choices.every(choice => choice.length < 20)) {
    conv.ask(new Suggestions(choices));
  }
}

exports.contestWhich = function(db, conv, params) {
  return db
    .collection('users').doc(conv.user.storage.uniqid)
    .collection('elections').doc('upcoming')
    .get()
    .then(snapshot => {
      const election = snapshot.exists ? snapshot.data() : null;
      const context = conv.contexts.get(constants.CMD_CONTEST_WHICH);
      const filtered = election.contests && context.parameters && context.parameters.contests ?
        context.parameters.contests
          .filter(index => index < election.contests.length)
          .map(index => election.contests[index]) : [];
      const input = conv.input.raw;
      const contests = filtered.filter(contest => _normalize(contest.name).indexOf(_normalize(input)) !== -1);
      if (contests.length === 1) {
        _askCandidatesInContest(conv, contests[0]);
      }
      if (contests.length !== 1) {
        conv.contexts.set(constants.CMD_CONTEST_WHICH, 1, context.parameters);
        let msg = `Sorry I am not sure which contest.`;
        if (filtered && filtered.length > 1) {
          const names = filtered.map(contest => contest.name);
          msg += ` Is it ${_joinWith(names, ', or ')}?`;
        }
        conv.ask(msg);
      }
      return Promise.resolve();
    });
}

exports.candidate = function(db, conv, params) {
  if (!conv.user.storage.uniqid) {
    conv.user.storage.uniqid = uniqid('actions-');
    _askForPlace(conv, false);
    return Promise.resolve();
  }

  if (conv.data.query && !params.query) {
    params.query = conv.data.query.text;
  }

  return db
    .collection('users').doc(conv.user.storage.uniqid)
    .collection('elections').doc('upcoming')
    .get()
    .then(snapshot => {
      const election = snapshot.exists ? snapshot.data() : null;
      const input = conv.input.raw;
      const results = election ? _findCandidates(election.contests, input, params) : [];
      return _replyCandidates('on your ballot', results, conv, input, params);
    });
}

function _replyCandidates(where, results, conv, input, params) {
  if (results.length === 1) {
    const contest = results[0][0];
    const candidate = results[0][1][0];
    const desc = _describeCandidate(conv, contest, candidate);
    let msg = desc[0];
    const card = desc[1];

    const others = contest.candidates
      .map((candidate, index) => {
        candidate.index = index;
        return candidate;
      })
      .filter(other => other !== candidate)
    const names = others.map(candidate => candidate.name);

    conv.ask(`<speak>${msg}</speak>`);
    if (card) {
      conv.ask(card);
    }

    if (others.length === 1) {
      conv.contexts.set(constants.CMD_CHOICES, 1, {
        contest: contest.index,
        candidates: others.map(candidate => candidate.index)
      });
      conv.ask(`Would you like to hear about the other candidate, ${names[0]}?`);
    }
    if (others.length > 1) {
      conv.contexts.set(constants.CMD_CHOICES, 1, {
        contest: contest.index,
        candidates: others.map(candidate => candidate.index)
      });
      conv.ask(`Would you like to hear about the other candidates? I have ${_joinWith(names, ', and ')}.`);
      _showSuggestions(conv, names);
    }
    return Promise.resolve();
  }

  const context = conv.contexts.get(constants.CMD_CHOICES);
  if (context && context.parameters) {
    conv.contexts.set(constants.CMD_CHOICES, 1, context.parameters);
  }
  const query = [
    params ? params.candidate : null,
    params && params.party ? _partyCandidate(params.party) : null,
    params ? params.query : null,
    input
  ].find(q => q);
  conv.ask(`Sorry I didn't find ${query} ${where}. Ask me about another candidate?`);
  conv.ask(new Suggestions(['help']));

  return Promise.resolve();
}

exports.candidateInContest = function(db, conv, params) {
  return db
    .collection('users').doc(conv.user.storage.uniqid)
    .collection('elections').doc('upcoming')
    .get()
    .then(snapshot => {
      const election = snapshot.exists ? snapshot.data() : null;
      const input = conv.input.raw;
      const context = conv.contexts.get(constants.CMD_CANDIDATE_IN_CONTEST);

      const generalResults = election ? _findCandidates(election.contests, input, params) : [];
      if (!context || !context.parameters || !context.parameters.contest) {
        return _replyCandidates('on your ballot', generalResults, conv, input, params);
      }

      const contest = election && election.contests ? election.contests[context.parameters.contest] : null;
      if (contest) {
        contest.index = context.parameters.contest;
      }
      const candidates = election ?  _findCandidatesInContest(contest.candidates, input, params) : [];
      const results = candidates.length > 0 ? [ [ contest, candidates ] ] : [];
      if (results.length > 0) {
        return _replyCandidates(`in ${contest.name}`, results, conv, input, params);
      } else {
        return _replyCandidates('on your ballot', generalResults, conv, input, params);
      }
    });
}

exports.loadCandidate = function(election, contestPos, candidatePos) {
  return _loadCandidate(election, contestPos, candidatePos);
}

function _loadCandidate(election, contestPos, candidatePos) {
  if (!election) {
    return null;
  }
  if (!election.contests || contestPos >= election.contests.length) {
    return null;
  }
  const contest = election.contests[contestPos];
  if (!contest || !contest.candidates || candidatePos >= contest.candidates.length) {
    return null;
  }
  contest.index = contestPos;
  return [contest, contest.candidates[candidatePos]];
}

function _describeCandidate(conv, contest, candidate) {
  let msg = `${candidate.name} is ${_partyCandidate(candidate.party)}running for ${contest.name}.`;
  let card = null;
  if (candidate.video) {
    if (conv.surface.capabilities.has('actions.capability.SCREEN_OUTPUT')) {
      card = new BasicCard({
        buttons: new Button({
          title: 'Play video',
          url: candidate.video.url
        }),
        image: {
          url: candidate.video.thumbnail,
          accessibilityText: `Video for ${candidate.name}`
        }
      });
    } else {
      if (conv.surface.capabilities.has('actions.capability.AUDIO_OUTPUT') && candidate.video.audio) {
        msg += `<audio src="${candidate.video.audio}"></audio>`;
      }
    }
  }
  return [msg, card];
}

function _partyCandidate(query) {
  const party = constants.PARTY_NAMES[query] || query;
  return party ? `a ${party} candidate ` : '';
}

function _normalize(str) {
  return str.toLowerCase().replace(/[,.-/:]/g, '').replace(/ +/g, ' ');
}

exports.findContests = function(election, input, params) {
  if (!election) {
    return [];
  }
  return _findContests(election.contests, input, params);
}

function _findContests(contests, input, params) {
  if (!contests) {
    return [];
  }

  contests.forEach((contest, index) => {
    contest.index = index;
  });

  input = _normalize(input);
  let matches = contests.filter(contest =>
    _normalize(contest.name) === input
  );
  if (matches.length > 0) {
    return matches;
  }

  if (!params) {
    return [];
  }

  Object.keys(params).forEach(key => {
    const value = params[key];
    if (typeof value === 'string') {
      if (key === 'number') {
        params[key] = parseInt(value);
      } else {
        params[key] = _normalize(value);
      }
    }
  })

  // Contest match
  if (params.original) {
    matches = _matchName(contests, params, params.original);
    if (matches.length > 0) {
      return matches;
    }
  }

  // Office match
  if (params.office) {
    matches = _matchName(contests, params, params.office);
    if (matches.length > 0) {
      return matches;
    }
  }

  // US House
  if (params.office === 'representative' &&
      (!params.state || input.indexOf('cd') !== -1)) {
    matches = _matchType(contests, params, 'cd');
    if (matches.length === 1) {
      return matches;
    }
  }

  // State Senate
  if (params.office === 'state senate' ||
      (params.office === 'senator' && params.state)) {
    matches = _matchType(contests, params, 'sldu');
    if (matches.length === 1) {
      return matches;
    }
  }

  // State House
  if (params.office === 'state house' ||
      (params.office === 'representative' && params.state)) {
    matches = _matchType(contests, params, 'sldl');
    if (matches.length === 1) {
      return matches;
    }
  }

  // Query, contest & input
  const queries = [params.query, params.original, input]
    .filter(q => q && q.length > 0)
    .map(q => _normalize(q));

  for (let query of queries) {
    // Exact match
    matches = contests.filter(contest => _normalize(contest.name) === query);
    if (matches.length > 0) {
      return matches;
    }

    // Substring match
    matches = contests.filter(contest => _normalize(contest.name).indexOf(query) !== -1);
    if (matches.length > 0) {
      return matches;
    }
  }

  if (params.office && params.office.length > 0) {
    for (let query of ['commissioner', 'education', 'regent']) {
      if (params.office.indexOf(query) !== -1) {
        return _matchName(contests, params, query);
      }
    }
  }

  return [];
}

function _matchType(contests, params, expectedType) {
  return contests.filter(contest => {
    if (!contest.params) {
      return false;
    }
    if (contest.params.type !== expectedType) {
      return false;
    }
    if (params.state &&
        contest.params.state !== params.state &&
        contest.params.state !== constants.US_STATES[params.state]) {
      return false;
    }
    return !params.number || params.number === contest.params.number
  });
}

function _matchName(contests, params, expectedSubstring) {
  return contests.filter(contest => {
    let name = _normalize(contest.name);
    if (name.indexOf(expectedSubstring) === -1) {
      return false;
    }

    // Country level
    if (params.country === 'united states of america' &&
        contest.params &&
       (contest.params.type === 'sldu' || contest.params.type === 'sldl')) {
        return false;
    }

    // State level
    if (params.state &&
        contest.params &&
        contest.params.state !== params.state &&
        contest.params.state !== constants.US_STATES[params.state]) {
      return false;
    }

    // Match district number or at-large. No constraints returns all.
    if (!params.number && !params.scope) {
      return true;
    }

    return contest.params &&
          (params.number === contest.params.number ||
          (params.scope === 'at-large' && !contest.params.number));
  });
}

exports.findCandidates = function(election, input, params) {
  if (!election) {
    return [];
  }
  return _findCandidates(election.contests, input, params);
}

function _findCandidates(contests, input, params) {
  if (!contests) {
    return [];
  }

  contests.forEach((contest, index) => {
    contest.index = index;
  });

  return contests
    .map(contest => [contest, _findCandidatesInContest(contest.candidates, input, params)])
    .filter(results => results[1].length > 0);
}

function _findCandidatesInContest(candidates, input, params) {
  if (!candidates) {
    return [];
  }

  candidates.forEach((candidate, index) => {
    candidate.index = index;
  });

  const queries = [params ? params.candidate : null, params ? params.query : null, input]
    .filter(q => q)
    .map(q => _normalize(q));

  // Exact match
  for (let query of queries) {
    let matches = candidates.filter(candidate =>
      candidate.name && _normalize(candidate.name) === query);
    if (matches.length > 0) {
      return matches;
    }
  }

  // Substring match
  for (let query of queries) {
    let matches = candidates.filter(candidate =>
      candidate.name && _normalize(candidate.name).indexOf(query) !== -1);
    if (matches.length > 0) {
      return matches;
    }
  }

  return [];
}

exports.fallback = function(db, conv, params) {
  return db
    .collection('users').doc(conv.user.storage.uniqid)
    .collection('elections').doc('upcoming')
    .get()
    .then(snapshot => {
      const election = snapshot.exists ? snapshot.data() : null;
      const input = _normalize(conv.input.raw);
      if (!_genericSearch(conv, election, input, params)) {
        _replyGenerically(conv);
      }
      return Promise.resolve();
    });
}

exports.triggerQuery = function(db, conv, params) {
  return db
    .collection('users').doc(conv.user.storage.uniqid)
    .collection('elections').doc('upcoming')
    .get()
    .then(snapshot => {
      const election = snapshot.exists ? snapshot.data() : null;
      const input = _normalize(conv.input.raw);

      if (!election) {
        const suffix = conv.data.query ? ` Please ask for ${conv.data.query.text} again in a bit.` : '';
        conv.ask(`Sorry, I'm still looking.${suffix}`);
        conv.ask(new Suggestions([conv.data.query.text]));
        return Promise.resolve();
      }

      if (!_genericSearch(conv, election, input, params)) {
        _replyGenerically(conv);
      }

      return Promise.resolve();
    });
}

function _genericSearch(conv, election, input, params) {
  if (conv.data.query && !params.query) {
    params.query = conv.data.query.text;
  }

  if (election) {
    // Contests
    const contests = election ? _findContests(election.contests, input, params) : [];
    if (contests.length > 0) {
      _replyContests(conv, contests);
      return true;
    }
    // Candidates
    const results = election ? _findCandidates(election.contests, input, params) : [];
    if (results.length > 0) {
      _replyCandidates('on your ballot', results, conv, input, params);
      return true;
    }
  }

  return false;
}

function _replyGenerically(conv) {
  const genericReply = [
    "I didn't get that. Can you say it again?",
    "I missed what you said. Say it again?",
    "Sorry, could you say that again?",
    "Sorry, can you say that again?",
    "Can you say that again?",
    "Sorry, I didn't get that.",
    "Sorry, what was that?",
    "One more time?",
    "What was that?",
    "Say that again?",
    "I didn't get that.",
    "I missed that."
  ];
  conv.ask(_pickRandomly(genericReply));
  conv.ask(new Suggestions(['help']));
}

exports.choiceByOrdinal = function(db, conv, params) {
  return db
    .collection('users').doc(conv.user.storage.uniqid)
    .collection('elections').doc('upcoming')
    .get()
  .then(snapshot => {
    const election = snapshot.exists ? snapshot.data() : null;
    const context = conv.contexts.get(constants.CMD_CHOICES);
    if (!election || !context || !context.parameters || !params.ordinal) {
      _replyGenerically(conv);
      return Promise.resolve();
    }
    const index = params.ordinal - 1;

    if (context.parameters.contest && context.parameters.contest < election.contests.length &&
        context.parameters.candidates && index < context.parameters.candidates.length) {
      const contest = election.contests[context.parameters.contest];
      const candidatePos = context.parameters.candidates[index];
      const candidate = contest.candidates[candidatePos];
      const results = [ [ contest, [candidate] ] ];
      _replyCandidates(`in ${contest.name}`, results, conv, conv.input.raw, params);
      return Promise.resolve();
    }

    if (context.parameters.contests && index < context.parameters.contests.length) {
      const contestPos = context.parameters.contests[index];
      const contest = election.contests[contestPos];
      contest.index = contestPos;
      _askCandidatesInContest(conv, contest);
      return Promise.resolve();
    }

    _replyGenerically(conv);
    return Promise.resolve();
  });
}

exports.choiceByParty = function(db, conv, params) {
  return db
    .collection('users').doc(conv.user.storage.uniqid)
    .collection('elections').doc('upcoming')
    .get()
  .then(snapshot => {
    const election = snapshot.exists ? snapshot.data() : null;
    const context = conv.contexts.get(constants.CMD_CHOICES);

    if (!election || !context || !context.parameters || !params.party) {
      _replyGenerically(conv);
      return Promise.resolve();
    }

    if (context.parameters.contest && context.parameters.contest < election.contests.length &&
        context.parameters.candidates) {
      const queries = [params.party, constants.PARTY_NAMES[params.party]]
        .filter(q => q)
        .map(q => _normalize(q));
      const contest = election.contests[context.parameters.contest];
      const candidates = context.parameters.candidates
        .map(index => contest.candidates[index])
        .filter(candidate => candidate.party)
        .filter(candidate => queries.includes(_normalize(candidate.party)));
      const results = candidates && candidates.length > 0 ? [ [ contest, candidates ] ] : [];
      _replyCandidates(`in ${contest.name}`, results, conv, conv.input.raw, params);
      return Promise.resolve();
    }

    _replyGenerically(conv);
    return Promise.resolve();
  });
}


exports.choiceConfirm = function(db, conv, params) {
  return db
    .collection('users').doc(conv.user.storage.uniqid)
    .collection('elections').doc('upcoming')
    .get()
  .then(snapshot => {
    const election = snapshot.exists ? snapshot.data() : null;
    const context = conv.contexts.get(constants.CMD_CHOICES);
    if (!election || !context || !context.parameters) {
      _replyGenerically(conv);
      return Promise.resolve();
    }

    if (context.parameters.contest && context.parameters.contest < election.contests.length &&
        context.parameters.candidates && context.parameters.candidates.length === 1) {
      const contest = election.contests[context.parameters.contest];
      const candidatePos = context.parameters.candidates[0];
      const candidate = contest.candidates[candidatePos];
      const results = [ [ contest, [candidate] ] ];
      _replyCandidates(`in ${contest.name}`, results, conv, conv.input.raw, params);
      return Promise.resolve();
    }

    _replyGenerically(conv);
    return Promise.resolve();
  });
}

exports.bye = function(db, conv) {
  if (!conv.user.storage.uniqid) {
    conv.close(`Thank you for using Ballot Guide. Remember to vote!`);
    return Promise.resolve();
  }

  return db
    .collection('users').doc(conv.user.storage.uniqid)
    .collection('elections').doc('upcoming')
    .get()
  .then(snapshot => {
    const election = snapshot.exists ? snapshot.data() : null;
    const lang = election ? election.lang : null;
    const electionDay = election && election.election && election.election.electionDay ?
      _shortDate(election.election.electionDay, lang) : null;
    const suffix = electionDay ? ` on ${electionDay}` : '';
    conv.close(`<speak>Thank you for using Ballot Guide. Remember to vote${suffix}!</speak>`);
    return Promise.resolve();
  });
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
  return ['line1', 'line2', 'line3', 'city', 'state']
    .map(key => fields[key])
    .filter(s => s && s.trim().length > 0)
    .join(', ');
}

function _replyUpcomingElection(conv, election, prefix, returning) {
  if (!election) {
    const context = conv.contexts.get(constants.CMD_FETCH_ELECTION);
    if (context && context.lifespan === 1) {
      _setConfirmContext(conv, constants.CMD_ELECTION_INFO);
      conv.ask(`<speak>Sorry, I'm still compiling the results. ` +
        `<break time="1s"/>Why does it take so long? ` +
        `<break time="1s"/>First, I take your voting address and look up your voting districts, ` +
        `for instance, congressional district, county, state house, and more. ` +
        `<break time="1s"/>Then, I figure out ` +
        `the elections for each of them, and put it all together. ` +
        `<break time="1s"/>Should be done any moment now. ` +
        `<break time="1s"/>Please say upcoming election again in a little bit. Thanks!</speak>`);
    } else {
      conv.ask(`Sorry, I'm still looking.
        Please try again by saying 'upcoming election' in a few moments.`);
    }
    conv.ask(new Suggestions(['upcoming election']));
    return election;
  }

  if (election.election && election.election.electionDay) {
    const name = election.election.name || 'an election';
    let msg = `${returning ? 'Welcome back! ' : ''}${prefix} ${name} on ${_formatDate(election.election.electionDay)}.`;

    if (_hasVotingLocation(election)) {
      const location = election.votingLocations[0];
      const place = location.address.locationName || location.formattedAddress;
      msg += `<break time="1s"/> You can vote at ${place}.`;
    }

    conv.ask('<speak>' + msg + '</speak>');

    _askVotingLocationCard(conv, election);

    if (_hasContests(election)) {
      _summarizeContests(conv, election);
      conv.ask(new Suggestions(['help']));
    } else {
      const checkAgain = _hasVotingLocation(election) ? '' :
        'Please check again in about a week for voting location and contests. ';
      conv.ask(`<speak><break time="1s"/>` +
        `That's all I know for now. ${checkAgain}` +
        `<break time="1s"/>Let me know if you need to change the voting address you gave me. ` +
        `If not, you can say "I'm done".</speak>`);
      conv.ask(new Suggestions(['bye']));
    }
  } else {
    _setContext(conv, constants.CMD_CHANGE_ADDRESS);
    const msg = returning ? `Welcome back! Right now I don't see any elections` : `Sorry, I couldn't find any elections`;
    conv.ask(new Confirmation(`${msg}. Would you like to change your address?`));
  }
  return election;
}

function _askVotingLocationCard(conv, election) {
  if (!_hasVotingLocation(election) ||
      !conv.surface.capabilities.has('actions.capability.SCREEN_OUTPUT')) {
    return;
  }
  const location = election.votingLocations[0];
  const place = location.address.locationName || location.formattedAddress;
  const address = encodeURI(location.formattedAddress);

  const params = {
    markers: `color:orange%7C${address}`,
    zoom: 15,
    size: '320x240',
    key: nconf.get('api_key')
  };
  const imageUrl = 'https://maps.googleapis.com/maps/api/staticmap?' +
    Object.keys(params).map(key => key + '=' + params[key]).join('&');

  conv.ask(new BasicCard({
    title: place,
    subtitle: location.address.locationName ? location.formattedAddress : null,
    buttons: new Button({
      title: 'Open map',
      url: 'https://www.google.com/maps?q=' + address
    }),
    image: {
      url: imageUrl,
      accessibilityText: `Map for ${location.formattedAddress}`
    }
  }));
}

function _replyVotingLocations(conv, election) {
  if (_hasVotingLocation(election)) {
    const location = election.votingLocations[0];
    const place = location.address.locationName || location.formattedAddress;
    const msg = `You can vote at ${place}.`;

    if (conv.data.version >= 4) {
      conv.ask(msg);
      _askVotingLocationCard(conv, election);
      conv.ask(`What else would you like to know about?`);
    } else {
      _askVotingLocationCard(conv, election);
      conv.close(msg);
    }
  } else {
    conv.close(`Sorry, I couldn't find any voting locations.`);
  }
  return election;
}

function _replyContestsSummary(conv, election) {
  if (_hasContests(election)) {
    _summarizeContests(conv, election);
  } else {
    conv.close(`Sorry, I couldn't find any contests.`);
  }

  return election;
}

function _replyContestsAll(conv, election) {
  if (_hasContests(election)) {
    const prefix = election.contests.length === 1 ?
      'There is 1 contest' : `There are ${election.contests.length} contests`;
    const names = election.contests.map(contest => contest.name);
    const suffix = conv.data.version >= 4 ? ` ${_whichOne('contest')}` : '';

    conv.contexts.set(constants.CMD_CHOICES, 1, {
      contests: election.contests.map((_, index) => index)
    });

    conv.ask(`${prefix}: ${_joinWith(names, ', and ')}.${suffix}`);
    _showSuggestions(conv, names);
  } else {
    conv.close(`Sorry, I couldn't find any contests.`);
  }

  return election;
}

function _whichOne(type) {
  const choices = [
    `Which ${type} would you like to hear about?`,
    `Which one would you like to hear about?`
  ];
  return _pickRandomly(choices);
}

function _pickRandomly(choices) {
  return choices[Math.floor(Math.random() * choices.length)];
}

function _summarizeContests(conv, election) {
  if (!_hasContests(election)) {
    return;
  }

  if (election.contests.length === 1) {
    _setContext(conv, constants.CMD_CONTEST_ONE);
    const msg = `There is one contest: ${election.contests[0].name}.`;
    if (conv.data.version >= 4) {
      conv.ask(`${msg} Would you like to hear about it?`);
    } else {
      conv.close(msg);
    }
    return;
  }

  _setContext(conv, constants.CMD_CONTEST);

  const prefix = election.contests.length === 2 ?
    'There are two contests: ' : `There are ${election.contests.length} contests, including `;
  const twoContests = `${election.contests[0].name} and ${election.contests[1].name}.`;
  const suffix = _whichOne('contest');

  conv.contexts.set(constants.CMD_CHOICES, 1, {
    contests: election.contests.map((_, index) => index)
  });

  if (conv.data.version >= 4) {
    conv.ask(`${prefix} ${twoContests} ${suffix}`);
  } else {
    conv.close(`${prefix} ${twoContests}`);
  }
}

function _help(conv, election) {
  if (conv.data.version >= 4) {
    const options = [ ];
    if (_hasVotingLocation(election)) {
      options.push(`Where can I vote?`);
    }
    if (_hasContests(election)) {
      const contest = _pickRandomly(election.contests
        .filter(contest => contest.candidates && contest.candidates.length > 0));
      options.push(`Who is running for ${contest.name}?`);
      if (contest.candidates && contest.candidates.length > 0) {
        const candidate = _pickRandomly(contest.candidates);
        options.push(`Tell me about the candidate ${candidate.name}.`);
      }
    }
    if (options.length > 0) {
      conv.ask(`<speak>
        <p>Here are some things you can ask:</p>
        ${options.map(option => `<p>${option}</p>`).join(' ')}
      </speak>`);
    }
    conv.ask(`For a summary, you can ask, What's on my ballot?`);

    options.push(`What's on my ballot?`);
    _showSuggestions(conv, options);

    // Clear contexts
    [
      constants.CMD_CHOICES,
      constants.CMD_CONTEST_WHICH,
      constants.CMD_CANDIDATE_IN_CONTEST,
    ].forEach(cmd => conv.contexts.set(cmd, 0, {}));
  } else {
    const suggestions = _getElectionSuggestions(election);
    if (suggestions.length > 0) {
      conv.ask(`Try ${_joinWith(suggestions, ', or ')}?`);
    }
  }
}

function _setContext(conv, context) {
  const sanitized = context.split(' ').join('-');
  conv.contexts.set(sanitized, 1, {});
}

function _setConfirmContext(conv, context) {
  _setContext(conv, `${context}-confirm`);
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
  return `${year}-${month}-${day}`;
}

function _shortDate(dateStr, lang) {
  const year = dateStr.substring(0, 4);
  const month = parseInt(dateStr.substring(4, 6));
  const day = dateStr.substring(6, 8);
  const date = new Date(year, month-1, day);
  return date.toLocaleDateString(lang || 'en', {month: 'long', day: 'numeric'});
}

function _joinWith(items, lastConnector) {
  if (items.length > 1) {
    return items.slice(0, -1).join(', ') + lastConnector + items.slice(-1);
  } else {
    return items.join(', ');
  }
}
