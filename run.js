/**
 * Copyright 2017 IBM Corp. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the 'License'); you may not
 * use this file except in compliance with the License. You may obtain a copy of
 * the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an 'AS IS' BASIS, WITHOUT
 * WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the
 * License for the specific language governing permissions and limitations under
 * the License.
 */

 /* jshint esversion: 6 */

require('dotenv').config({ silent: true });

const watson = require('watson-developer-cloud');
const FS = require('fs');
const MIC = require('mic');
const PLAYER = require('play-sound')(opts = {});
const PROBE = require('node-ffprobe');
const REQUEST = require('request-promise');
const PROMISE = require('promise');

var mlbTeams;
var mlbTeamsRetrieved = false;
var mlbStandings;
var mlbStandingsRetrieved = false;
var mlbScheduleDates = [];
var mlbSchedule = [];
var scheduleDaysCollected = 0;
var mlbScheduleRetrieved = false;
var textPhoneNo = '';
var context = {};

var debug = false;


/**
 * Create Watson Services.
 */
const conversation = new watson.AssistantV1({
  version: '2018-02-16'
});

const speech_to_text = new watson.SpeechToTextV1({
//  url: 'https://stream.watsonplatform.net/speech-to-text/api/'
});

const tone_analyzer = new watson.ToneAnalyzerV3({
  version: '2017-09-21'
});

const text_to_speech = new watson.TextToSpeechV1({
  url: 'https://stream.watsonplatform.net/text-to-speech/api'
});

const discovery = new watson.DiscoveryV1({
  version: '2018-03-05'
});


/**
 * Create Twilio Client.
 */
const TWILIO = require('twilio')(
  process.env.TWILIO_SID,
  process.env.TWILIO_AUTH_TOKEN
);
const TWILIO_PHONE_NO = process.env.TWILIO_PHONE_NUMBER;
// If phone number to always text to is found in config file, use it.
if (process.env.TWILIO_TEXT_PHONE_NUMBER) {
  textPhoneNo = process.env.TWILIO_TEXT_PHONE_NUMBER;
  context.text_sent = 'success';
}


/**
 * Retrieve key to 3rd party MLB data
 */
const MLB_DATA_KEY = process.env.MLB_FANTASY_SPORTS_KEY;


/**
 * Create and configure the microphone.
 */
const MIC_PARAMS = {
  rate: 44100,
  channels: 2,
  debug: false,
  exitOnSilence: 6
};
const MIC_INSTANCE = MIC(MIC_PARAMS);
const MIC_INPUT_STREAM = MIC_INSTANCE.getAudioStream();

let pauseDuration = 0;
MIC_INPUT_STREAM.on('pauseComplete', ()=> {
  console.log('Microphone paused for', pauseDuration, 'seconds.');
  // Stop listening when speaker is talking.
  setTimeout(function() {
      MIC_INSTANCE.resume();
      console.log('Microphone resumed.');
  }, Math.round(pauseDuration * 1000));
});

/**
 * Get current date
 */
function getCurrentDate() {
  var date;
  if (process.env.IN_OFF_SEASON) {
    // all saved data is from Sept 28, 2017
    date = new Date(2017, 8, 28);
  } else {
    date = new Date();
  }
  return date;
}

/**
 * Get current MLB team info from MLB Fantasy Data.
 */
function getMlbTeams() {
  const options = {
    method: 'GET',
    uri: 'https://api.fantasydata.net/mlb/v2/JSON/teams',
    headers: {
      'Host': 'api.fantasydata.net',
      'Ocp-Apim-Subscription-Key': process.env.MLB_FANTASY_SPORTS_KEY
    }
  };

  return new PROMISE((resolve, reject) => {
    REQUEST(options)
      .then(function (response) {
        mlbTeams = JSON.parse(response);
        return resolve();
      })
      .catch(function (err) {
        console.log('Unable to retrieve current MLB team info. ', err);
        return reject(err);
      });
  });
}


/**
 * Get current MLB standings from MLB Fantasy Data.
 */
function getMlbStandings() {
  const options = {
    method: 'GET',
    uri: 'https://api.fantasydata.net/mlb/v2/JSON/Standings/' + MLB_SEASON,
    headers: {
      'Host': 'api.fantasydata.net',
      'Ocp-Apim-Subscription-Key': MLB_DATA_KEY
    }
  };

  return new PROMISE((resolve, reject) => {
    REQUEST(options)
      .then(function (response) {
        mlbStandings = JSON.parse(response);
        return resolve();
      })
      .catch(function (err) {
        console.log('Unable to retrieve current MLB standings. ', err);
        return reject(err);
      });
  });
}


/**
 * Get current MLB schedules from MLB Fantasy Data. Just grab schedules
 * from today and for the next week.
 */
function getMlbSchedules() {
  var monthNames = [
    'JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL',
    'AUG', 'SEP', 'OCT', 'NOV', 'DEC'
  ];

  var date = getCurrentDate();

  return new PROMISE((resolve, reject) => {
    for (let i = 0; i < 7; i++) {
      /* jshint loopfunc: true */
      date.setDate(date.getDate() + 1);
      month = date.getMonth();
      day = ("0" + date.getDate()).slice(-2);
      const options = {
        method: 'GET',
        uri: 'https://api.fantasydata.net/mlb/v2/JSON/GamesByDate/' + MLB_SEASON + '-' +
              monthNames[month] + '-' + day,
        headers: {
          'Host': 'api.fantasydata.net',
          'Ocp-Apim-Subscription-Key': MLB_DATA_KEY
        }
      };

      REQUEST(options)
        .then(function (response) {
          daySchedule = JSON.parse(response);
          if (daySchedule.length > 0) {
            console.log('Retrieved schedule for date: ' + daySchedule[0].Day);
            // Save each date in array so that they can be sorted
            // after all dates are retrieved.
            mlbScheduleDates[mlbScheduleDates.length] = daySchedule;
          } else {
            console.log('Retrieved schedule for date: NO GAMES FOUND');
          }
          scheduleDaysCollected += 1;
          if (scheduleDaysCollected === 7) {
            return resolve();
          }
        })
        .catch(function (err) {
          console.log('Unable to retrieve current MLB schedules. ', err);
          return reject(err);
        });
    }
  });
}


/**
 * Sort the MLB schedule by date. This is needed because each day is
 * requested separately, and are returned in random order.
 */
function sortSchedule() {
  var date = getCurrentDate();
  var daysProcessed = 0;

  while (daysProcessed < 7) {
    date.setDate(date.getDate() + 1);
    for (let i = 0; i < mlbScheduleDates.length; i++) {
      if (mlbScheduleDates[i][0].Day.substring(5,10) ===
           date.toJSON().substring(5,10)) {
        mlbSchedule = mlbSchedule.concat(mlbScheduleDates[i]);
        daysProcessed += 1;
        break;
      }
    }
  }
}


/**
 * Get current MLB standings for a specific team.
 *
 * @param {String} team
 *   Team to get standings for.
 */
function getCurrentStandings(team, standingsData) {
  if (standingsData) {
    let places = ['first', 'second', 'third', 'fourth', 'last'];
    let placeIdx;
    let place = '';
    let div = '';
    for (let i = 0; i < standingsData.length; i++) {
      let currentDiv = standingsData[i].League + standingsData[i].Division;
      if (div === '' || div !== currentDiv) {
        div = currentDiv;
        placeIdx = 0;
      } else {
        placeIdx++;
      }
      place = places[placeIdx];

      let compTeam = standingsData[i].Name;
      if (team.indexOf(compTeam) > -1) {
        return place;
      }
    }

    return 'unknown';
  }
}
exports.getCurrentStandings = getCurrentStandings;


/**
 * Get upcoming MLB schedule for a specific team.
 *
 * @param {String} team
 *   Team to get schedule for.
 */
function getUpcomingSchedule(team) {
  // First determine abbreviated team name required for looking at schedules.
  var teamKey = '';
  if (mlbTeams) {
    for (let i = 0; i < mlbTeams.length; i++) {
      let compTeam = mlbTeams[i].Name;
      if (team.indexOf(compTeam) > -1) {
        teamKey = mlbTeams[i].Key;
        break;
      }
    }
  }

  var schedString = 'No schedule data found for ' + team;
  if (teamKey && mlbSchedule) {
    schedString = 'Upcoming schedule for the ' + team + ':\n';
    var gameCount = 0;
    var date = getCurrentDate();
    var dayCtr = 0;
    var done = false;
    while (! done) {
      date.setDate(date.getDate() + 1);
      dayCtr++;
      for (let i = 0; i < mlbSchedule.length; i++) {
        // Limit schedule to just next 5 games.
        if (mlbSchedule[i].Day.substring(5,10) ===
            date.toJSON().substring(5,10)) {
          var game = '';
          if (mlbSchedule[i].AwayTeam === teamKey) {
            game = mlbSchedule[i].DateTime.substring(5,10) +
              ' ' + mlbSchedule[i].DateTime.substring(11,16) +
              ' @ ' + mlbSchedule[i].HomeTeam + '\n';
          } else if (mlbSchedule[i].HomeTeam === teamKey) {
            game = mlbSchedule[i].DateTime.substring(5,10) +
              ' ' + mlbSchedule[i].DateTime.substring(11,16) +
              ' vs. ' + mlbSchedule[i].AwayTeam + '\n';
          }
          if (game) {
            schedString = schedString.concat(game);
            gameCount += 1;
            if (gameCount === 5) {
              done = true;
            }
            break;
          }
        }
      }
      if (dayCtr === 7) {
        // don't look more than a week out to find 5 games
        // this is needed for end of season
        done = true;
      }
    }

    console.log("schedString " + schedString);
    return schedString;
  }
}


/**
 * Convert phone number from words to numbers.
 *
 * @param {String} spokenPhoneNumber
 *   Text of spoken phone number that needs to be converted to digits.
 */
function getUserPhoneNumber(spokenPhoneNumber) {
  // Spoken phone number is a space seperated string.
  var phoneNum = '+1';
  words = spokenPhoneNumber.split(' ');
  for (let i = 0; i < words.length; i++) {
    switch(words[i]) {
      case 'one':
        phoneNum = phoneNum + '1';
        break;
      case 'two':
        phoneNum = phoneNum + '2';
        break;
      case 'three':
        phoneNum = phoneNum + '3';
        break;
      case 'four':
        phoneNum = phoneNum + '4';
        break;
      case 'five':
        phoneNum = phoneNum + '5';
        break;
      case 'six':
        phoneNum = phoneNum + '6';
        break;
      case 'seven':
        phoneNum = phoneNum + '7';
        break;
      case 'eight':
        phoneNum = phoneNum + '8';
        break;
      case 'nine':
        phoneNum = phoneNum + '9';
        break;
      case 'zero':
        phoneNum = phoneNum + '0';
        break;
    }
  }

  return phoneNum;
}
exports.getUserPhoneNumber = getUserPhoneNumber;  // export for mocha unit tests

/**
 * Text team info to user.
 * This includes schedule, and Watson headlines
 */
function textTeamInfo() {
  // Validate phone number is legitimate.
  if (context.text_sent != 'success') {
    // Only use number if needed (first time or last time was with invalid #).
    textPhoneNo = getUserPhoneNumber(context.phoneno);
  }

  if (textPhoneNo.length != 12) {
    console.log('Unable to text: bad phone number: ', textPhoneNo);
    context.text_sent = 'failure';
    return;
  }

  console.log('Will send text to: ', textPhoneNo);

  // Query for headlines from watson news.
  let headlines = [];
  const numHeadlines = 2;

  discovery.query({
    environment_id: process.env.DISCOVERY_ENVIORNMENT_ID,
    collection_id: process.env.DISCOVERY_COLLECTION_ID,
    query: context.my_team + ' baseball',
    count: 5
  }, (err, response) => {
    if (response.results) {
      for (let i = 0; i < response.results.length; i++) {
        // Make sure headline is not a duplicate, which Watson news
        // does on occasion.
        headline = response.results[i].title + ' - ' + response.results[i].url;
        var dup = false;
        for (let j = 0; j < headlines.length; j++) {
          if (headline === headlines[j]) {
            dup = true;
            break;
          }
        }
        if (! dup) {
          headlines.push(headline);
          if (headlines.length >= numHeadlines) {
            break;
          }
        }
      }
    }

    // Get next 5 game schedule for team.
    sched = getUpcomingSchedule(context.my_team);

    // Text schedule to user.
    context.text_sent = 'success';
    TWILIO.messages.create({
        to: textPhoneNo,
        from: TWILIO_PHONE_NO,
        body: sched,
    }, function(err, message) {
        console.log(message.sid);
        // Now text each headline to user.
        for (let i = 0; i < headlines.length; i++) {
          /* jshint loopfunc: true */
          TWILIO.messages.create({
              to: textPhoneNo,
              from: TWILIO_PHONE_NO,
              body: headlines[i],
          }, function(err, message) {
              console.log(message.sid);
          });
      }
    });

    // Tell user text has been sent.
    console.log('Schedule and headlines have been sent');
    printContext('before call 4:');
    conversation.message({
      workspace_id: process.env.CONVERSATION_WORKSPACE_ID,
      input: {'text': ''},
      context: context
    }, (err, response) => {
      context = response.context;
      printContext('after call 4:');
      watsonResponse = response.output.text[0];
      speakResponse(watsonResponse);
      watsonSays(watsonResponse);
    });
  });
}


/**
 * Convert speech to text.
 */
const textStream = MIC_INPUT_STREAM.pipe(
  speech_to_text.createRecognizeStream({
    content_type: 'audio/l16; rate=44100; channels=2',
  })).setEncoding('utf8');


/**
 * Get emotional tone from speech.
 */
const getEmotion = (text) => {
  return new Promise((resolve) => {
    let maxScore = 0.01;
    let emotion = 'default';
    tone_analyzer.tone({text: text}, (err, tone) => {
      let tones = tone.document_tone.tone_categories[0].tones;
      for (let i=0; i<tones.length; i++) {
        if (tones[i].score > maxScore){
          maxScore = tones[i].score;
          emotion = tones[i].tone_id;
        }
      }
      resolve({emotion, maxScore});
    });
  });
};


/**
 * Convert text to speech.
 */
const speakResponse = (text) => {
  const params = {
    text: text,
    voice: process.env.TJBOT_VOICE,
    accept: 'audio/wav'
  };

  text_to_speech.synthesize(params)
  .pipe(FS.createWriteStream('output.wav'))
  .on('close', () => {
    PROBE('output.wav', function(err, probeData) {
      pauseDuration = probeData.format.duration + 0.2;
      MIC_INSTANCE.pause();
      PLAYER.play('output.wav');
    });
  });
};


/**
 * Check conversation step.
 * True if we are attempting to validate the team the user wishes to follow.
 */
function validateTeamStep() {
  if (context &&
      context.system &&
      context.system.dialog_stack[0] === 'Validate Team') {
    return true;
  }
  return false;
}


/**
 * Check conversation step.
 * True if we are attempting to validate the users team sentiment tone.
 */
function validateEmotionStep() {
  if (context &&
      context.system &&
      context.system.dialog_stack[0] === 'Validate Emotion') {
    return true;
  }
  return false;
}


/**
 * Check conversation step.
 * True if we are attempting to text team info to the user.
 */
function textTeamInfoStep() {
  if (context &&
      context.system &&
      context.system.dialog_stack[0] === 'Text Team Info') {
    return true;
  }
  return false;
}


/**
 * Log Watson Conversation context values..
 *
 * @param {String} header
 *   First line of log message.
 */
function printContext(header) {
  if (debug) {
    console.log(header);

    if (context.system) {
      if (context.system.dialog_stack) {
        console.log("     dialog_stack: ['" +
                    context.system.dialog_stack + "']");
      }
      if (context.emotion) {
        console.log("     emotion: " + context.emotion);
      }
      if (context.my_team) {
        console.log("     my_team: " + context.my_team);
      }
      if (context.standings) {
        console.log("     standings: " + context.standings);
      }
      if (context.phoneno) {
        console.log("     phoneno: " + context.phoneno);
      }
    }
  }
}

/**
 * Send significant responses from Watson to the console.
 */
function watsonSays(response) {
  if (typeof(response) !== 'undefined') {
    console.log('Watson says:', response);
  }
}

/**
 * Watson conversation with user.
 */
function mlbConversation() {
  console.log('TJBot is listening, you may speak now.');
  speakResponse('Hi there, I am awake.');

  textStream.on('data', (user_speech_text) => {
    userSpeechText = user_speech_text.toLowerCase();
    console.log('\n\nWatson hears: ', user_speech_text);
    printContext('before call 1:');
    conversation.message({
      workspace_id: process.env.CONVERSATION_WORKSPACE_ID,
      input: {'text': user_speech_text},
      context: context
    }, (err, response) => {
      context = response.context;
      printContext('after call 1:');

      watson_response =  response.output.text[0];
      if (watson_response) {
        speakResponse(watson_response);
      }
      watsonSays(watson_response);

      if (validateEmotionStep()) {
        // User has expressed sentiment about team.
        getEmotion(context.emotion).then((detectedEmotion) => {
          context.emotion = detectedEmotion.emotion;
          printContext('before call 2:');
          conversation.message({
            workspace_id: process.env.CONVERSATION_WORKSPACE_ID,
            input: {'text': userSpeechText},
            context: context
          }, (err, response) => {
            context = response.context;
            printContext('after call 2:');
            watson_response = response.output.text[0];
            speakResponse(watson_response);
            watsonSays(watson_response);
          });
        });
      } else if (validateTeamStep()) {
        // User has identified which team they want to follow.
        context.standings = getCurrentStandings(context.my_team, mlbStandings);
        printContext('before call 3:');
        conversation.message({
          workspace_id: process.env.CONVERSATION_WORKSPACE_ID,
          input: {'text': userSpeechText},
          context: context
        }, (err, response) => {
          context = response.context;
          printContext('after call 3:');
          watson_response =  response.output.text[0];
          speakResponse(watson_response);
          watsonSays(watson_response);
        });
      } else if (textTeamInfoStep()) {
        // User has requested that team info be texted to them.
        textTeamInfo();
      }
    });
  });
}


/**
 * Load all MLB data and start conversation when completed.
 */
function init() {
  if (process.env.IN_OFF_SEASON) {
    var fs = require('fs');
    mlbTeams = JSON.parse(fs.readFileSync('data/mlb-teams.json', 'utf8'));
    mlbStandings = JSON.parse(fs.readFileSync('data/mlb-standings.json', 'utf8'));
    mlbScheduleDates = JSON.parse(fs.readFileSync('data/mlb-schedule.json', 'utf8'));

    sortSchedule();

    mlbTeamsRetrieved = true;
    mlbStandingsRetrieved = true;
    mlbScheduleRetrieved = true;
    startConversationIfReady();

  } else {
    // Generate data to be used during the conversation.
    getMlbTeams()
      .then(function() {
        console.log('Retrieved MLB Teams');
        mlbTeamsRetrieved = true;
        startConversationIfReady();
      })
      .catch(err => {
        throw new Error('Error loading MLB team info');
      });
    getMlbStandings()
      .then(function() {
        console.log('Retrieved MLB standings');
        mlbStandingsRetrieved = true;
        startConversationIfReady();
      })
      .catch(err => {
        throw new Error('Error loading MLB standings');
      });
    getMlbSchedules()
      .then(function() {
        console.log('Retrieved MLB schedules');
        sortSchedule();
        mlbScheduleRetrieved = true;
        startConversationIfReady();
      })
      .catch(err => {
        throw new Error('Error loading MLB schedules');
      });
    }
}


/**
 * Start the conversation once all MLB data is loaded.
 */
function startConversationIfReady() {
  if (mlbTeamsRetrieved && mlbStandingsRetrieved && mlbScheduleRetrieved) {
    // Initialize microphone
    MIC_INSTANCE.start();

    // Begin watson conversation.
    mlbConversation();
  }
}

// Start by loading MLB data
init();
