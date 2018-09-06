## Configure Firebase
1. Under Authentication, select sign-in method. Enable Google and Anonymous
2. Under Database, click "Get started"


## Deploy Cloud Functions

1. Follow [Firebase Cloud Functions](https://firebase.google.com/docs/functions/get-started) instructions:
  * `npm install -g firebase-tools`
  * `firebase login`
  *  During `firebase init`, don't override anything.
2. Create `functions/config.json` with this:      
       {
         "api_key": your_api_key
       }
   Generate your_api_key from [Google API console](https://console.cloud.google.com/apis), with Civic Information and Places API enabled. You may need to go through this site to set up billing for Places API: https://cloud.google.com/maps-platform/places.
3. Inside the `functions` directory, run `npm install`.
4. `firebase deploy --only functions`


## More info
See [DESIGN.md](https://github.com/GetBallot/mobile/blob/master/DESIGN.md) in the [mobile](https://github.com/GetBallot/mobile) repo
