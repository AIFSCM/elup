'use strict';

const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

const FUSION_HOST_RAW = process.env.FUSION_HOST || 'https://elup.fa.em2.oraclecloud.com/';
const FUSION_HOST = FUSION_HOST_RAW.replace(/\/+$/, ''); // strip trailing slash(es) to avoid double-slash URLs
const FUSION_USER = process.env.FUSION_USER || '';
const FUSION_PASS = process.env.FUSION_PASS || '';
const CLIENT_ID = process.env.CLIENT_ID || '';
const CLIENT_SECRET = process.env.CLIENT_SECRET || '';
const TOKEN_URL = process.env.TOKEN_URL || 'https://idcs-98e1e16c2ea349b29486184a7ff70b5c.identity.oraclecloud.com/oauth2/v1/token';
const AGENT_CODE = process.env.AGENT_CODE || 'AR_COLLECTIONS_ASSISTANT';
const WA_TOKEN = process.env.WA_TOKEN || '';
const PHONE_ID = process.env.PHONE_ID || '1086132367916692';
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'mySecret123';

// ALLOWLIST: comma-separated WhatsApp numbers permitted to use this agent.
// Format must match message.from exactly as WhatsApp sends it (digits only,
// country code, no "+", no spaces) e.g. ALLOWED_NUMBERS=923004188817,923001234567
const ALLOWED_NUMBERS = (process.env.ALLOWED_NUMBERS || '')
  .split(',')
  .map(function(n) { return n.trim(); })
  .filter(Boolean);

// FAIL-CLOSED: if ALLOWED_NUMBERS is empty/unset, NO ONE is allowed through.
// This is deliberate since this is an access-control feature -- set the env
// var before going live, or every message will be silently blocked.
function isAllowedNumber(phone) {
  if (ALLOWED_NUMBERS.length === 0) {
    console.warn('ALLOWED_NUMBERS is empty -- blocking ALL numbers until it is set');
    return false;
  }
  return ALLOWED_NUMBERS.indexOf(phone) !== -1;
}

let cachedToken = null;
let tokenExpiresAt = 0;

// sessions[phone] = { conversationId, lastCustomer, lastActive }
const sessions = {};
const SESSION_TTL_MS = 45 * 60 * 1000; // 45 min inactivity -> auto reset

// Very lightweight customer-name extractor.
// Looks for capitalized multi-word phrases ending in common company suffixes,
// e.g. "Al Shaheer Corporation (Private) Limited", "ABC Traders Pvt Ltd".
// Falls back to null if nothing matches (session customer stays unchanged).
function extractCustomerHint(text) {
  if (!text) return null;
  var suffixPattern = /([A-Z][A-Za-z&.\-]*(?:\s+[A-Z][A-Za-z&.\-]*){0,5}\s+(?:Corporation|Corp|Company|Co\.?|Limited|Ltd\.?|Pvt\.?|Private|Industries|Traders|Enterprises|Group|Inc\.?))(?:\s*\([^)]*\))?/;
  var match = text.match(suffixPattern);
  if (match) return match[1].trim().toLowerCase();
  return null;
}

function getSession(phone) {
  var s = sessions[phone];
  if (!s) return null;
  if (Date.now() - s.lastActive > SESSION_TTL_MS) {
    console.log('Session expired for ' + phone + ' (TTL)');
    delete sessions[phone];
    return null;
  }
  return s;
}

async function getOAuthToken() {
  try {
    if (cachedToken && Date.now() < tokenExpiresAt) {
      console.log('Using cached token');
      return cachedToken;
    }
    console.log('Fetching OAuth token...');
    const params = new URLSearchParams();
    params.append('grant_type', 'password');
    params.append('username', FUSION_USER);
    params.append('password', FUSION_PASS);
    params.append('scope', 'urn:opc:resource:fusion:elup:fusion-ai/');
    const res = await axios.post(TOKEN_URL, params.toString(), {
      auth: { username: CLIENT_ID, password: CLIENT_SECRET },
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });
    cachedToken = res.data.access_token;
    tokenExpiresAt = Date.now() + ((res.data.expires_in || 3600) - 60) * 1000;
    console.log('Token obtained OK');
    return cachedToken;
  } catch (err) {
    console.error('Token error: ' + JSON.stringify(err.response ? err.response.data : err.message));
    throw new Error('Token failed');
  }
}

async function callOracleAgent(userMessage, conversationId) {
  try {
    var token = await getOAuthToken();

    // "conversational" must be explicitly set to true, or Oracle treats every
    // call as a stateless one-shot request and never issues/honors a conversationId.
    // conversationId must be sent as null (not omitted) to start a fresh session,
    // and as the previous value to continue one.
    var body = {
      message: userMessage,
      conversational: true,
      conversationId: conversationId || null
    };

    var invokeURL = FUSION_HOST + '/api/fusion-ai/orchestrator/agent/v2/' + AGENT_CODE + '/invokeAsync';
    console.log('Calling invokeAsync: ' + invokeURL);
    console.log('Request body: ' + JSON.stringify(body));
    var invokeRes = await axios.post(invokeURL, body, {
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json'
      }
    });
    console.log('invokeAsync raw response: ' + JSON.stringify(invokeRes.data));
    var jobId = invokeRes.data.jobId;
    var convId = invokeRes.data.conversationId;
    console.log('Job ID: ' + jobId);
    var statusURL = FUSION_HOST + '/api/fusion-ai/orchestrator/agent/v2/' + AGENT_CODE + '/status/' + jobId;
    console.log('Status URL: ' + statusURL);
    for (var i = 0; i < 20; i++) {
      await new Promise(function(r) { setTimeout(r, 2000); });
      var statusRes = await axios.get(statusURL, {
        headers: { 'Authorization': 'Bearer ' + token }
      });
      var status = statusRes.data.status;
      console.log('Poll ' + (i + 1) + ' status: ' + status);
      if (status === 'COMPLETE') {
        console.log('Full response: ' + JSON.stringify(statusRes.data));
        var reply = '';
        if (statusRes.data.output) {
          reply = statusRes.data.output;
        } else if (statusRes.data.message) {
          reply = statusRes.data.message;
        } else {
          reply = 'Request completed but no response text found.';
        }
        // Prefer the conversationId from the COMPLETE status payload
        // (most authoritative), fall back to the one returned by invokeAsync.
        var finalConvId = statusRes.data.conversationId || convId || null;
        console.log('Agent reply: ' + reply);
        console.log('Resolved conversationId for this turn: ' + finalConvId);
        return { reply: reply, conversationId: finalConvId };
      }
      if (status === 'FAILED' || status === 'ERROR') {
        console.error('Agent failed: ' + JSON.stringify(statusRes.data));
        return { reply: 'Sorry, the agent failed to process your request.', conversationId: convId || conversationId || null };
      }
    }
    return { reply: 'Agent is taking too long. Please try again.', conversationId: conversationId || null };
  } catch (err) {
    console.error('Agent error: ' + JSON.stringify(err.response ? err.response.data : err.message));
    // callDirectAPI fallback has been removed/disabled -- return a plain
    // error message instead of crashing on a call to a missing function.
    return {
      reply: 'Sorry, something went wrong connecting to Oracle. Please try again shortly.',
      conversationId: conversationId || null
    };
  }
}

async function sendWhatsApp(to, text) {
  try {
    var waUrl = 'https://graph.facebook.com/v18.0/' + PHONE_ID + '/messages';
    console.log('WhatsApp URL: ' + waUrl);
    console.log('Sending to: ' + to);
    await axios.post(waUrl, {
      messaging_product: 'whatsapp',
      to: to,
      type: 'text',
      text: { body: text }
    }, {
      headers: {
        'Authorization': 'Bearer ' + WA_TOKEN,
        'Content-Type': 'application/json'
      }
    });
    console.log('WhatsApp sent to: ' + to);
  } catch (e) {
    console.error('WhatsApp error: ' + e.message);
    console.error('WhatsApp details: ' + JSON.stringify(e.response ? e.response.data : 'no response'));
  }
}

app.get('/', function(req, res) {
  res.send('Oracle AI Agent WhatsApp Bridge is running OK');
});

app.get('/debug', function(req, res) {
  res.json({
    FUSION_HOST: FUSION_HOST,
    AGENT_CODE: AGENT_CODE,
    TOKEN_URL: TOKEN_URL,
    CLIENT_ID: CLIENT_ID ? 'SET' : 'NOT SET',
    CLIENT_SECRET: CLIENT_SECRET ? 'SET' : 'NOT SET',
    FUSION_USER: FUSION_USER ? 'SET' : 'NOT SET',
    FUSION_PASS: FUSION_PASS ? 'SET' : 'NOT SET',
    WA_TOKEN: WA_TOKEN ? 'SET' : 'NOT SET',
    PHONE_ID: PHONE_ID,
    VERIFY_TOKEN: VERIFY_TOKEN ? 'SET' : 'NOT SET',
    ALLOWED_NUMBERS_COUNT: ALLOWED_NUMBERS.length,
    ALLOWED_NUMBERS: ALLOWED_NUMBERS // remove this line if you don't want numbers visible via /debug
  });
});

app.get('/sessions', function(req, res) {
  res.json(sessions);
});

app.get('/webhook', function(req, res) {
  var mode = req.query['hub.mode'];
  var token = req.query['hub.verify_token'];
  var challenge = req.query['hub.challenge'];
  console.log('Webhook verify token: ' + token);
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('Webhook verified OK');
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

app.post('/webhook', async function(req, res) {
  res.sendStatus(200);
  try {
    var entry = req.body && req.body.entry && req.body.entry[0];
    var change = entry && entry.changes && entry.changes[0];
    var value = change && change.value;
    var message = value && value.messages && value.messages[0];
    if (!message || message.type !== 'text') return;
    var userPhone = message.from;
    var userText = message.text.body;

    // ALLOWLIST CHECK -- must happen before any processing, logging of
    // content, session lookup, or Oracle call.
    if (!isAllowedNumber(userPhone)) {
      console.log('Blocked message from unauthorized number: ' + userPhone);
      return; // silently ignore -- no reply sent, no Oracle call made
    }

    console.log('Message from ' + userPhone + ': ' + userText);

    var session = getSession(userPhone);
    var detectedCustomer = extractCustomerHint(userText);
    var convIdToSend = null;

    if (session) {
      if (detectedCustomer && session.lastCustomer && detectedCustomer !== session.lastCustomer) {
        // Customer changed mid-thread -> force a fresh agent session
        console.log('Customer switch detected for ' + userPhone + ': "' + session.lastCustomer + '" -> "' + detectedCustomer + '". Resetting context.');
        convIdToSend = null;
      } else {
        // Same customer (or no new customer mentioned) -> keep the thread going
        convIdToSend = session.conversationId;
      }
    }

    console.log('conversationId being sent for this turn: ' + convIdToSend);

    await sendWhatsApp(userPhone, 'Processing your request, please wait...');
    var result = await callOracleAgent(userText, convIdToSend);

    sessions[userPhone] = {
      conversationId: result.conversationId || null,
      // keep prior customer if this message didn't mention one; otherwise update it
      lastCustomer: detectedCustomer || (session ? session.lastCustomer : null),
      lastActive: Date.now()
    };

    console.log('conversationId stored after this turn: ' + sessions[userPhone].conversationId);

    await sendWhatsApp(userPhone, result.reply);
  } catch (e) {
    console.error('Webhook error: ' + e.message);
  }
});

var PORT = process.env.PORT || 3000;
app.listen(PORT, function() {
  console.log('Server running on port ' + PORT);
  console.log('FUSION_HOST: ' + FUSION_HOST);
  console.log('AGENT_CODE: ' + AGENT_CODE);
  console.log('CLIENT_ID set: ' + !!CLIENT_ID);
  console.log('FUSION_USER: ' + (FUSION_USER ? 'SET' : 'NOT SET'));
  console.log('WA_TOKEN set: ' + !!WA_TOKEN);
  console.log('PHONE_ID: ' + PHONE_ID);
  console.log('ALLOWED_NUMBERS configured: ' + ALLOWED_NUMBERS.length + ' number(s)');
  if (ALLOWED_NUMBERS.length === 0) {
    console.warn('WARNING: ALLOWED_NUMBERS is not set -- ALL incoming messages will be blocked.');
  }
});
