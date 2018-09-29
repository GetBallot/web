const chai = require('chai');
const assert = chai.assert;

const test = require('firebase-functions-test')();

describe('CivicInfo', () => {
  const ATTORNEY_GENERAL = { name: 'Attorney General' };
  const US_SENATOR = {
    name: 'United States Senator',
    params: {
      type: 'country'
    }
  };
  const CO_CD_4 = {
    name: 'Congressional District 4',
    params: {
      type: 'cd',
      state: 'co',
      number: 4
    }
  };
  const CO_HD_50 = {
    name: 'State House District 50',
    params: {
      type: 'sldl',
      state: 'co',
      number: 50
    }
  };
  const KS_SD_6 = {
    name: 'Kansas Senator 6',
    params: {
      type: 'sldu',
      state: 'ks',
      number: 6
    }
  };
  const COUNTY_COMMISSIONER_AT_LARGE = {
    name: 'Commissioner At-Large',
    params: {
      type: 'county',
      state: 'co'
    }
  };
  const COUNTY_COMMISSIONER_2 = {
    name: 'Commissioner District 2',
    params: {
      type: 'council_district',
      state: 'co',
      number: 2
    }
  };
  const LESLEY_SMITH = {
    name: 'Lesley Smith'
  }
  const REGENT_AT_LARGE = {
    name: 'Regent of the University of Colorado - At Large',
    params: {
      type: 'state',
      state: 'co'
    },
    candidates: [ LESLEY_SMITH ]
  };
  const REGENT_CD_5 = {
    name: 'Regent of the University of Colorado - District 5',
    params: {
      type: 'cd',
      state: 'co',
      number: 5
    }
  };

  before(() => {
    civicinfo = require('../civicinfo');
  });

  after(() => {
    test.cleanup();
  });

  describe('findContests', () => {
    it('should return exact match from input', () => {
      const election = {
        contests: [ ATTORNEY_GENERAL ]
      };
      const input = ATTORNEY_GENERAL['name'];
      const params = null;

      const contests = civicinfo.findContests(election, input, params);
      assert.equal(1, contests.length);
      assert.equal(ATTORNEY_GENERAL, contests[0]);
    });

    it('should return country level when there is no state', () => {
      const election = {
        contests: [ US_SENATOR, KS_SD_6 ]
      };
      const input = 'Senate';
      const params = { office: 'Senator', country: 'United States of America' };

      const contests = civicinfo.findContests(election, input, params);
      assert.equal(1, contests.length);
      assert.equal(US_SENATOR, contests[0]);
    });

    it('should return all senators', () => {
      const election = {
        contests: [ US_SENATOR, KS_SD_6 ]
      };
      const input = 'Senator';
      const params = { office: 'Senator' };

      const contests = civicinfo.findContests(election, input, params);
      assert.equal(2, contests.length);
      assert.equal(US_SENATOR, contests[0]);
      assert.equal(KS_SD_6, contests[1]);
    });

    it('should return us house with district number', () => {
        const election = {
          contests: [ CO_CD_4, CO_HD_50 ]
        };
        const input = 'CD 4';
        const params = {
          office: 'Representative',
          number: 4
        };

        const contests = civicinfo.findContests(election, input, params);
        assert.equal(1, contests.length);
        assert.equal(CO_CD_4, contests[0]);
      });

    it('should return state house with district number', () => {
      const election = {
        contests: [ CO_CD_4, CO_HD_50 ]
      };
      const input = 'Colorado HD 50';
      const params = {
        office: 'State House',
        state: 'Colorado',
        number: 50
      };

      const contests = civicinfo.findContests(election, input, params);
      assert.equal(1, contests.length);
      assert.equal(CO_HD_50, contests[0]);
    });

    it('should return colorado house with district number', () => {
      const election = {
        contests: [ CO_CD_4, CO_HD_50 ]
      };
      const input = 'Colorado House 50';
      const params = {
        office: 'Representative',
        state: 'Colorado',
        number: '50'
      };

      const contests = civicinfo.findContests(election, input, params);
      assert.equal(1, contests.length);
      assert.equal(CO_HD_50, contests[0]);
    });

    it('should return state house without district number', () => {
      const election = {
        contests: [ CO_CD_4, CO_HD_50 ]
      };
      const input = 'State House';
      const params = {
        office: 'State House',
      };

      const contests = civicinfo.findContests(election, input, params);
      assert.equal(1, contests.length);
      assert.equal(CO_HD_50, contests[0]);
    });

    it('should not return state house with mismatching district number', () => {
      const election = {
        contests: [ CO_CD_4, CO_HD_50 ]
      };
      const input = 'State House 48';
      const params = {
        office: 'State House',
        number: 48
      };

      const contests = civicinfo.findContests(election, input, params);
      assert.isEmpty(contests);
    });

    it('should not return state house with mismatching state', () => {
      const election = {
        contests: [ CO_CD_4, CO_HD_50 ]
      };
      const input = 'Kansas HD 50';
      const params = {
        office: 'State House',
        state: 'ks',
        number: 50
      };

      const contests = civicinfo.findContests(election, input, params);
      assert.isEmpty(contests);
    });

    it('should return state house with state name and district number', () => {
      const election = {
        contests: [ CO_CD_4, CO_HD_50 ]
      };
      const input = 'Colorado House District 50';
      const params = {
        office: 'Representative',
        state: 'Colorado',
        number: 50
      };

      const contests = civicinfo.findContests(election, input, params);
      assert.equal(1, contests.length);
      assert.equal(CO_HD_50, contests[0]);
    });

    it('should return state house with state name and no district number', () => {
      const election = {
        contests: [ CO_CD_4, CO_HD_50 ]
      };
      const input = 'Colorado House';
      const params = {
        office: 'Representative',
        state: 'Colorado',
      };

      const contests = civicinfo.findContests(election, input, params);
      assert.equal(1, contests.length);
      assert.equal(CO_HD_50, contests[0]);
    });

    it('should return state senate with state name', () => {
      const election = {
        contests: [ US_SENATOR, KS_SD_6 ]
      };
      const input = 'Kansas Senate';
      const params = {
        office: 'Senator',
        state: 'Kansas',
      };

      const contests = civicinfo.findContests(election, input, params);
      assert.equal(1, contests.length);
      assert.equal(KS_SD_6, contests[0]);
    });

    it('should return all county commissioners', () => {
      const election = {
        contests: [ COUNTY_COMMISSIONER_2, COUNTY_COMMISSIONER_AT_LARGE ]
      };
      const input = 'County Commissioner';
      const params = {
        office: 'County Commissioner',
        state: 'Colorado',
      };

      const contests = civicinfo.findContests(election, input, params);
      assert.equal(2, contests.length);
      assert.equal(COUNTY_COMMISSIONER_2, contests[0]);
      assert.equal(COUNTY_COMMISSIONER_AT_LARGE, contests[1]);
    });

    it('should return county commissioner by district', () => {
      const election = {
        contests: [ COUNTY_COMMISSIONER_2, COUNTY_COMMISSIONER_AT_LARGE ]
      };
      const input = 'County Commissioner 2';
      const params = {
        office: 'County Commissioner',
        state: 'Colorado',
        number: 2
      };

      const contests = civicinfo.findContests(election, input, params);
      assert.equal(1, contests.length);
      assert.equal(COUNTY_COMMISSIONER_2, contests[0]);
    });

    it('should return county commissioner at-large', () => {
      const election = {
        contests: [ COUNTY_COMMISSIONER_2, COUNTY_COMMISSIONER_AT_LARGE ]
      };
      const input = 'County Commissioner At-Large';
      const params = {
        office: 'County Commissioner',
        scope: 'At-Large'
      };

      const contests = civicinfo.findContests(election, input, params);
      assert.equal(1, contests.length);
      assert.equal(COUNTY_COMMISSIONER_AT_LARGE, contests[0]);
    });

    it('should return all cu regents', () => {
      const election = {
        contests: [ REGENT_AT_LARGE, REGENT_CD_5 ]
      };
      const input = 'Who is running for CU Regent?';
      const params = {
        office: 'University Regent'
      };

      const contests = civicinfo.findContests(election, input, params);
      assert.equal(2, contests.length);
      assert.equal(REGENT_AT_LARGE, contests[0]);
      assert.equal(REGENT_CD_5, contests[1]);
    });

    it('should return regent by district', () => {
      const election = {
        contests: [ REGENT_AT_LARGE, REGENT_CD_5 ]
      };
      const input = 'Who is running for CU Regent District 5?';
      const params = {
        office: 'University Regent',
        number: 5
      };

      const contests = civicinfo.findContests(election, input, params);
      assert.equal(1, contests.length);
      assert.equal(REGENT_CD_5, contests[0]);
    });

    it('should not return regent with mismatching district', () => {
      const election = {
        contests: [ REGENT_AT_LARGE, REGENT_CD_5 ]
      };
      const input = 'Who is running for CU Regent District 4?';
      const params = {
        office: 'University Regent',
        number: 4
      };

      const contests = civicinfo.findContests(election, input, params);
      assert.equal(0, contests.length);
    });

    it('should return regent at large', () => {
      const election = {
        contests: [ REGENT_AT_LARGE, REGENT_CD_5 ]
      };
      const input = 'CU Regent At-Large';
      const params = {
        office: 'University Regent',
        scope: 'At-Large'
      };

      const contests = civicinfo.findContests(election, input, params);
      assert.equal(1, contests.length);
      assert.equal(REGENT_AT_LARGE, contests[0]);
    });
  });

  describe('findCandidates', () => {
    it('should return candidate by name', () => {
      const election = {
        contests: [ REGENT_AT_LARGE, ]
      };
      const input = LESLEY_SMITH.name;
      const params = {
        candidate: LESLEY_SMITH.name
      };

      const results = civicinfo.findCandidates(election, input, params);
      assert.isNotNull(results);
      assert.equal(1, results.length);
      assert.equal(REGENT_AT_LARGE, results[0][0]);
      assert.equal(LESLEY_SMITH, results[0][1][0]);
    });
  });

  describe('loadCandidates', () => {
    it('should return candidate', () => {
      const election = {
        contests: [ REGENT_CD_5, REGENT_AT_LARGE, ]
      };

      const results = civicinfo.loadCandidate(election, 1, 0);
      assert.isNotNull(results);
      assert.equal(REGENT_AT_LARGE, results[0]);
      assert.equal(LESLEY_SMITH, results[1]);
    });
  });
});