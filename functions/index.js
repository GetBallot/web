const functions = require('firebase-functions');

const admin = require('firebase-admin');
admin.initializeApp();

exports.userDivisionsChanged = functions.firestore
  .document('users/{userId}')
  .onWrite((change, context) => {
    if (!change.after.exists) {
      return;
    }

    const user = change.after.data();

    if (user.electionsCopyTrigger) {
      return change.after.ref.update({
        electionsCopyTrigger: admin.firestore.FieldValue.delete(),
        functionRan: admin.firestore.FieldValue.serverTimestamp()
      });
    }
  });
