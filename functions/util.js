exports.formatAddress = function(fields) {
  var address = ['line1', 'line2', 'line3', 'city', 'state']
    .map(key => fields[key])
    .filter(s => s && s.trim().length > 0)
    .join(', ')
  if (fields['zip']) {
    address += ' ' + fields['zip'];
  }
  return address;
}

exports.today = function() {
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

  return `${yyyy}${mm}${dd}`;
}

exports.sanitize = function(id) {
  return id.split('/').join(',')
}

exports.getLang = function(lang) {
  return 'en';
}
