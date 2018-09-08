const chai = require('chai');
const assert = chai.assert;

const test = require('firebase-functions-test')();

describe('Ballot', () => {
  const ADDRESS = '1263 Pacific Ave, Kansas City, KS';
  const OTHER_ADDRESS = 'Wichita, KS';
  const CANDIDATE_NAME = 'Kerri Evelyn Harris';
  const FAV_ID_VOTER = '4499|STATEWIDE|UNITED STATES SENATOR|KERRI EVELYN HARRIS';
  const FAV_ID_REP = '20180906|ocd-division,country:us,state:de|senate|KerriEvelynHarris';
  const SUPPLEMENT = {
    'favIdMap': []
  };

  let ballot, constants;

  before(() => {
    ballot = require('../ballot');
    constants = require('../constants');

    SUPPLEMENT.favIdMap[FAV_ID_VOTER] = FAV_ID_REP;
  });

  after(() => {
    test.cleanup();
  });

  describe('mergeElections', () => {
    it('should return null when all inputs are null', () => {
      const electionFromVoterInfo = null;
      const electionFromRepresentatives = null;
      const supplements = null;

      const election = ballot.mergeElections(
        electionFromVoterInfo, electionFromRepresentatives, supplements);
      assert.isNull(election);
    });

    it('should return voterInfo when it has election data', () => {
      const electionFromVoterInfo = {
        'election': {
          'electionDay': '20181106'
        },
        'address': ADDRESS,
        'source': constants.SOURCE_BALLOT
      };
      const electionFromRepresentatives = null;
      supplements = null;

      const election = ballot.mergeElections(
        electionFromVoterInfo, electionFromRepresentatives, supplements);
      assert.equal(electionFromVoterInfo, election);
    });

    it('should return voterInfo when repInfo has no election data', () => {
      const electionFromVoterInfo = {
        'address': ADDRESS,
        'source': constants.SOURCE_BALLOT
      };
      const electionFromRepresentatives = {
        'address': ADDRESS,
        'source': constants.SOURCE_GOOGLE
      };
      const supplement = null;

      const election = ballot.mergeElections(
        electionFromVoterInfo, electionFromRepresentatives, supplement);
      assert.equal(electionFromVoterInfo, election);
    });

    it('should return voterInfo when repInfo is null', () => {
      const electionFromVoterInfo = {
        'address': ADDRESS,
        'source': constants.SOURCE_BALLOT
      };
      const electionFromRepresentatives = null;
      const supplement = null;

      const election = ballot.mergeElections(
        electionFromVoterInfo, electionFromRepresentatives, supplement);
      assert.equal(electionFromVoterInfo, election);
    });

    it('should return repInfo when voterInfo is null', () => {
      const electionFromVoterInfo = null;
      const electionFromRepresentatives = {
        'address': ADDRESS,
        'source': constants.SOURCE_GOOGLE
      };

      const supplement = null;
      const election = ballot.mergeElections(
        electionFromVoterInfo, electionFromRepresentatives, supplement);
      assert.equal(electionFromRepresentatives, election);
    });

    it('should merge favIdMap into voterInfo', () => {
      const electionFromVoterInfo = {
        'address': ADDRESS,
        'source': constants.SOURCE_BALLOT,
        'election': {
          'electionDay': '20180906'
        },
        'contests': [
          {
            'candidates': [
              {
                'favId': FAV_ID_VOTER
              }
            ]
          }
        ]
      };
      const electionFromRepresentatives = null;

      const supplement = {
        'favIdMap': []
      };
      supplement.favIdMap[FAV_ID_VOTER] = FAV_ID_REP;

      const election = ballot.mergeElections(
        electionFromVoterInfo, electionFromRepresentatives, supplement);
      assert.equal(constants.SOURCE_BALLOT, election.source);
      assert.equal(FAV_ID_REP, election.contests[0].candidates[0].favId);
      assert.equal(FAV_ID_VOTER, election.contests[0].candidates[0].oldFavId);
    });

    it('should merge repInfo into voterInfo', () => {
      const electionFromVoterInfo = {
        'address': ADDRESS,
        'source': constants.SOURCE_BALLOT,
        'election': {
          'electionDay': '20180906'
        },
        'contests': [
          {
            'candidates': [
              {
                'favId': FAV_ID_VOTER
              }
            ]
          }
        ]
      };
      const electionFromRepresentatives = {
        'address': ADDRESS,
        'source': constants.SOURCE_GOOGLE,
        'election': {
          'electionDay': '20180906'
        },
        'contests': [
          {
            'candidates': [
              {
                'favId': FAV_ID_REP,
                'name': CANDIDATE_NAME
              }
            ]
          }
        ]
      };
      const supplement = SUPPLEMENT;

      const election = ballot.mergeElections(
        electionFromVoterInfo, electionFromRepresentatives, supplement);
      assert.equal(constants.SOURCE_BALLOT, election.source);
      assert.equal(FAV_ID_REP, election.contests[0].candidates[0].favId);
      assert.equal(FAV_ID_VOTER, election.contests[0].candidates[0].oldFavId);
      assert.equal(CANDIDATE_NAME, election.contests[0].candidates[0].name);
    });

    it('should not merge repInfo into voterInfo when addresses do not match', () => {
        const electionFromVoterInfo = {
          'address': ADDRESS,
          'source': constants.SOURCE_BALLOT,
          'election': {
            'electionDay': '20180906'
          },
          'contests': [
            {
              'candidates': [
                {
                  'favId': FAV_ID_VOTER
                }
              ]
            }
          ]
        };
        const electionFromRepresentatives = {
          'address': OTHER_ADDRESS,
          'source': constants.SOURCE_GOOGLE,
          'election': {
            'electionDay': '20180906'
          },
          'contests': [
            {
              'candidates': [
                {
                  'favId': FAV_ID_REP,
                  'name': CANDIDATE_NAME
                }
              ]
            }
          ]
        };

        const supplement = SUPPLEMENT;

        const election = ballot.mergeElections(
          electionFromVoterInfo, electionFromRepresentatives, supplement);
        assert.equal(constants.SOURCE_BALLOT, election.source);
        assert.equal(FAV_ID_REP, election.contests[0].candidates[0].favId);
        assert.equal(FAV_ID_VOTER, election.contests[0].candidates[0].oldFavId);
        assert.isUndefined(election.contests[0].candidates[0].name);
      });
  });
})