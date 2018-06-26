const SOURCE_GOOGLE = 'civicinfo#voterInfoResponse';
const SOURCE_BALLOT = 'getballot.com';

exports.compileElectionFromVoterinfo = function(election, lang) {
  election.lang = lang;
  election.source = SOURCE_GOOGLE;

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
          candidate.favId = _sanitize(favIdPrefix + '|' + candidate.name);
        });
      }

      if (contest.referendumBallotResponses) {
        contest.referendumBallotResponses.forEach((response) => {
          candidate.favId = _sanitize(favIdPrefix + '|' + response);
        });
      }
    })
  }

  election.votingLocations = _getMergedVotingLocations(election);

  return election;
}

exports.compileElectionFromRepresentatives = function(db, data, lang, electionFromVoterInfo) {
  const electionDay = electionFromVoterInfo ? electionFromVoterInfo.election.electionDay : null;

  const promises = [];
  for (var ocd in data.divisions) {
    promises.push(_getElectionPromise(db, lang, ocd, electionDay));
  }

  const electionId = electionFromVoterInfo === null ? null :
    electionFromVoterInfo.election.id;
  
  if (electionId !== null) {  
    promises.push(db.collection('elections').doc(electionId).get());
  }

  return Promise.all(promises)
    .then(divisionsSnap => {
      var supplement = null;
      if (electionId !== null) {
        const snapshot = divisionsSnap.pop();
        if (snapshot.exists) {
          supplement = snapshot.data();
        }
      }
            
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
      electionFromRepresentatives.lang = lang;

      return _mergeElections(
        electionFromVoterInfo, electionFromRepresentatives, supplement);
    });
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

exports.updateUserElectionSubscriptions = function(db, snap, userId, lambda) {
  const election = snap.data();    
  const lang = election.lang;

  const promises = [];

  if (election.contests) {
    promises.push.apply(promises, election.contests
      .filter(contest => 'division' in contest)
      .map(contest => db
        .collection('divisions').doc(contest.division)
        .collection('langs').doc(lang)
        .collection('elections').doc(election.election.electionDay)
        .collection('users').doc(userId))
      .map(lambda));
  }

  return promises;
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
        item.canonicalId = _sanitize(parts.join('|'));

        items.push(item);
      });
      const data = {};
      data[itemsKey] = items;
      return collectionRef.parent.set(data, {merge: true});
    });
}

function _mergeElections(electionFromVoterInfo, electionFromRepresentatives, supplement) {
  if (electionFromVoterInfo !== null) {
    if (electionFromVoterInfo.contests === null) {
      if (electionFromRepresentatives.contests) {
        electionFromVoterInfo.contests = electionFromRepresentatives.contests;
      }
    } else {
      if (supplement !== null && supplement.favIdMap) {
        const candidatesMap = _createFavIdToCandidateMap(electionFromRepresentatives);
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
    }
  }

  return electionFromVoterInfo === null ? 
    electionFromRepresentatives : electionFromVoterInfo;
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

function _createFavIdToCandidateMap(electionFromRepresentatives) {
  const map = {};
  if (electionFromRepresentatives.contests) {
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
  const election = {source: SOURCE_BALLOT}

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
    .filter(division => division.electionDay === upcoming.electionDay)
    .sort((a, b) => String(a.division).localeCompare(b.division))
    .map(division => division.contests.map(contest => {
       contest.division = division.division;
       
       if ('candidates' in contest) {
         contest.candidates.map(candidate => {
           candidate.favId = _sanitize([
            upcoming.electionDay, 
            division.division, 
             contest.id,
             candidate.id].join('|'));
           candidate.division = division.division;  
         });        
       }

       return contest
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
  const sanitizedOcd = _sanitize(ocd);
  const refPrefix = db
    .collection('divisions').doc(sanitizedOcd)
    .collection('langs').doc(lang)
    .collection('elections')
    
  const ref = electionDay ? 
    refPrefix
      .where('electionDay', '==', electionDay) : 
    refPrefix
      .where('electionDay', '>=', _today())
      .orderBy('electionDay');

  return ref.limit(1).get();
}

function _getMergedVotingLocations(election) {
  if (!election) {
    return [];
  }

  const keys = [];
  const map = new Map();

  if (election.pollingStations) {
    election.pollingStations.forEach(location => {
      _addVotingLocation(keys, map, location, 'pollingStation');
    });
    delete election['pollingStations'];
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
  const formattedAddress = _formatAddress(location.address);
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

function _formatAddress(fields) {
  var address = ['line1', 'line2', 'line3', 'city', 'state']
    .map(key => fields[key])
    .filter(s => s && s.trim().length > 0)
    .join(', ')
  if (fields['zip']) {
    address += ' ' + fields['zip'];
  }
  return address;
}

function _today() {
  var today = new Date();
  var dd = today.getDate();
  var mm = today.getMonth() + 1;
  var yyyy = today.getFullYear();

  if (dd < 10) {
    dd = '0' + dd
  }

  if (mm < 10) {
    mm = '0' + mm
  }

  return yyyy + '' + mm + '' + dd;
}

function _sanitize(id) {
  return id.split('/').join(',')
}
