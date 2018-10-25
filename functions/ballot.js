const util = require('./util.js');
const constants = require('./constants.js');

exports.compileElectionFromVoterinfo = function(election, address, lang) {
  election.lang = util.getLang(lang);
  election.source = constants.SOURCE_GOOGLE;
  if (address) {
    election.address = address;
  }

  election.election.electionDay
    = election.election.electionDay.split('-').join('');

  if (election.contests) {
    election.contests.forEach((contest) => {
      const district = contest.district.name;

      if (contest.referendumTitle) {
        contest.name = contest.referendumTitle;
      }
      if (contest.office) {
        contest.name = contest.office;
      }

      const favIdPrefix = [election.election.id, district, contest.name].join('|');

      if (contest.candidates) {
        contest.candidates.forEach((candidate) => {
          candidate.favId = util.sanitize(favIdPrefix + '|' + candidate.name);
        });
      } else {
        contest.candidates = [];
        if (contest.referendumBallotResponses) {
          contest.referendumBallotResponses.forEach((response) => {
            const candidate = {
              name: response,
              favId: util.sanitize(favIdPrefix + '|' + response)
            };
            contest.candidates.push(candidate);
          });
        }
      }
    })
  }

  election.votingLocations = _getMergedVotingLocations(election);

  return election;
}

exports.compileElectionFromRepresentatives = function(db, data, address, lang) {
  const sanitizedLang = util.getLang(lang);
  const electionDay = null;

  const promises = [];
  for (var ocd in data.divisions) {
    promises.push(_getElectionPromise(db, sanitizedLang, ocd, electionDay));
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

      const electionFromRepresentatives = _filterUpcomingElection(divisions);
      electionFromRepresentatives.lang = sanitizedLang;
      if (address) {
        electionFromRepresentatives.address = address;
      }

      return electionFromRepresentatives;
    });
}

exports.mergeElectionFromRepresentatives = function(db, userId, electionFromRepresentatives) {
 var electionFromVoterInfo = null;
 return db
   .collection('users').doc(userId)
   .collection('elections').doc('fromVoterInfo')
   .get()
   .then(snapshot => {
     if (snapshot.exists) {
       electionFromVoterInfo = snapshot.data();
     }
     const electionId = electionFromVoterInfo && electionFromVoterInfo.election ?
       electionFromVoterInfo.election.id : null;

     if (electionId) {
       return db.collection('elections').doc(electionId).get();
     } else {
       return Promise.resolve(null);
     }
   })
   .then(snapshot => {
     const supplement = snapshot && snapshot.exists ? snapshot.data() : null;
     return _mergeElections(
       electionFromVoterInfo, electionFromRepresentatives, supplement);
   })
}

exports.mergeElectionFromVoterInfo = function(db, userId, electionFromVoterInfo) {
 var electionFromRepresentatives = null;
 return db
   .collection('users').doc(userId)
   .collection('elections').doc('fromRepresentatives')
   .get()
   .then(snapshot => {
     if (snapshot.exists &&
         electionFromVoterInfo.address === snapshot.data().address) {
       electionFromRepresentatives = snapshot.data();
     }

     const electionId = electionFromVoterInfo && electionFromVoterInfo.election ?
       electionFromVoterInfo.election.id : null;

     if (electionId) {
       return db.collection('elections').doc(electionId).get();
     } else {
       return Promise.resolve(null);
     }
   })
   .catch(_ => {
     return Promise.resolve(null);
   })
   .then(snapshot => {
     const supplement = snapshot && snapshot.exists ? snapshot.data() : {};
     return _mergeElections(
       electionFromVoterInfo, electionFromRepresentatives, supplement);
   })
}

exports.copyElectionSupplement = function(db, election) {
  const updates = {};
  if ('contests' in election) {
    election.contests.forEach(contest => {
      if ('candidates' in contest) {
        contest.candidates.forEach(candidate => {
          if ('canonicalId' in candidate && 'favIds' in candidate) {
            candidate.favIds.forEach(favId => {
              const electionId = favId.split('|')[0];
              if (!(electionId in updates)) {
                updates[electionId] = {};
              }
              const update = updates[electionId];

              if (!('favIdMap' in update)) {
                update.favIdMap = {};
              }
              update.favIdMap[favId] = candidate.canonicalId;
            })
          }
        })
      }
    })
  }

  return Object.keys(updates).map(electionId =>
      db
        .collection('elections').doc(electionId)
        .set(updates[electionId], {merge: true})
    );
}

exports.summarizeArray = function(ref, context, itemsKey) {
  const collectionRef = ref.parent;
  return collectionRef.get()
    .then(querySnapshot => {
      const items = [];
      querySnapshot.forEach(itemSnap => {
        const item = itemSnap.data();
        item.id = itemSnap.ref.id;

        const parts = [context.params.electionDay, context.params.ocd];
        if (itemsKey === 'candidates') {
          parts.push(context.params.contestId);
        }
        parts.push(item.id);
        item.canonicalId = util.sanitize(parts.join('|'));

        items.push(item);
      });
      const data = {};
      data[itemsKey] = items.sort((a, b) => a.orderOnBallot - b.orderOnBallot);
      return collectionRef.parent.set(data, {merge: true});
    });
}

exports.mergeElections = function(electionFromVoterInfo, electionFromRepresentatives, supplement) {
  return _mergeElections(electionFromVoterInfo, electionFromRepresentatives, supplement);
}

function _mergeElections(electionFromVoterInfo, electionFromRepresentatives, supplement) {
  if (electionFromVoterInfo) {
    if (!electionFromVoterInfo.contests &&
        electionFromRepresentatives &&
        electionFromVoterInfo.address === electionFromRepresentatives.address &&
        electionFromRepresentatives.contests) {
      electionFromVoterInfo.contests = electionFromRepresentatives.contests;
    }
    if (electionFromVoterInfo.contests && supplement && supplement.favIdMap) {
      const candidatesMap = _createFavIdToCandidateMap(
        electionFromVoterInfo, electionFromRepresentatives);
      electionFromVoterInfo.contests.forEach(contest => {
        if (contest.candidates) {
          contest.candidates.forEach(candidate => {
            _updateCandidateFavId(supplement.favIdMap, candidate);
            if (candidatesMap[candidate.favId]) {
              Object.assign(candidate, candidatesMap[candidate.favId]);
              contest.division = candidate.division;
            }
          });
        }
      });
    }
    if (electionFromVoterInfo.election ||
        !electionFromRepresentatives ||
        (electionFromVoterInfo.address === electionFromRepresentatives.address &&
        !electionFromRepresentatives.election)) {
      return electionFromVoterInfo;
    }
  }

  return electionFromRepresentatives;
}

function _updateCandidateFavId(favIdMap, candidate) {
  const favId = candidate.favId;
  if (favId in favIdMap && favId !== favIdMap.favId) {
    const canonicalFavId = favIdMap[favId];
    Object.keys(favIdMap).forEach(key => {
      if (favIdMap[key] === canonicalFavId) {
        candidate.favId = canonicalFavId;
        candidate.oldFavId = key;
      }
    });
  }
}

function _createFavIdToCandidateMap(electionFromVoterInfo, electionFromRepresentatives) {
  const map = {};
  if (electionFromRepresentatives &&
      electionFromVoterInfo.address === electionFromRepresentatives.address &&
      electionFromRepresentatives.contests) {
    electionFromRepresentatives.contests.forEach(contest => {
      if (contest.candidates) {
        contest.candidates.forEach(candidate => {
          map[candidate.favId] = candidate;
        });
      }
    })
  }
  return map;
}

function _filterUpcomingElection(divisions) {
  const election = {source: constants.SOURCE_BALLOT}

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
    .filter(division => division.contests)
    .filter(division => division.electionDay === upcoming.electionDay)
    .sort((a, b) => String(a.division).localeCompare(b.division))
    .map(division => division.contests.map(contest => {
       contest.division = division.division;

       if ('candidates' in contest) {
         contest.candidates.forEach(candidate => {
           candidate.favId = util.sanitize([
            upcoming.electionDay,
            division.division,
             contest.id,
             candidate.id].join('|'));
           candidate.division = division.division;
         });
       }

       return contest;
    }))
    .reduce((acc, val) => acc.concat(val), []);

  election.election = {
    electionDay: upcoming.electionDay,
    name: upcoming.name
  };
  election.contests = contests;

  return election;
}

function _getElectionPromise(db, lang, ocd, electionDay) {
  const sanitizedOcd = util.sanitize(ocd);
  const refPrefix = db
    .collection('divisions').doc(sanitizedOcd)
    .collection('langs').doc(util.getLang(lang))
    .collection('elections')

  const ref = electionDay ?
    refPrefix
      .where('electionDay', '==', electionDay) :
    refPrefix
      .where('electionDay', '>=', util.today())
      .orderBy('electionDay');

  return ref.limit(1).get();
}

function _getMergedVotingLocations(election) {
  if (!election) {
    return [];
  }

  const keys = [];
  const map = new Map();

  if (election.pollingLocations) {
    election.pollingLocations.forEach(location => {
      _addVotingLocation(keys, map, location, 'pollingLocation');
    });
    delete election['pollingLocations'];
  }

  if (election.dropOffLocations) {
    election.dropOffLocations.forEach(location => {
      _addVotingLocation(keys, map, location, 'dropOffLocation');
    });
    delete election['dropOffLocations'];
  }

  if (election.earlyVoteSites) {
    election.earlyVoteSites.forEach(location => {
      _addVotingLocation(keys, map, location, 'earlyVoteSite');
    });
    delete election['earlyVoteSites'];
  }

  return keys.map(key => map[key]);
}

function _addVotingLocation(keys, map, location, type) {
  if (!location.address) {
    return;
  }

  const locationName = location.address.locationName;
  const formattedAddress = util.formatAddress(location.address);
  const key =
    locationName ? locationName + ', ' + formattedAddress : formattedAddress;

  if (!map[key]) {
    keys.push(key);
    map[key] = {
      address: location.address,
      formattedAddress: formattedAddress
    }
  }
  map[key][type] = location;
  delete map[key][type].address;
}
