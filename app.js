const express = require("express");
const serverless = require("serverless-http");
const AWS = require('aws-sdk');
const OAuth = require('oauth-1.0a');
const xml2js = require('xml2js');
const cheerio = require('cheerio');
const crypto = require('crypto');
const playwright = require('playwright-aws-lambda');
const { firefox } = require('playwright');



const app = express();
app.use(express.json());
app.listen(3000, () => console.log("Listening on port 3000"));


// group the constants together
const config = {
  authorize_url: 'https://us.etrade.com/e/t/etws/authorize',
  request_token_url: '/oauth/request_token',
  access_token_url: '/oauth/access_token',
  revoke_access_token_url: '/oauth/revoke_access_token',
  get_quote_url: '/v1/market/quote',
  aws: {
    region: 'us-east-2',
    parameter_store: {
      etrade_base_url_name: 'etrade_base_url',
      etrade_api_key_name: 'etrade_api_key',
      etrade_api_secret_name: 'etrade_api_secret',
      etrade_username_name: 'etrade_username',
      etrade_password_name: 'etrade_password',
    },
    dynamo_db_table_name: 'stock_price',
  },
};


AWS.config.update({ region: config.aws.region });
const ssm = new AWS.SSM();
const dynamoDbClient = new AWS.DynamoDB.DocumentClient();
const ssmParams = {
  Names: [
    config.aws.parameter_store.etrade_base_url_name,
    config.aws.parameter_store.etrade_api_key_name, 
    config.aws.parameter_store.etrade_api_secret_name,
    config.aws.parameter_store.etrade_username_name,
    config.aws.parameter_store.etrade_password_name,
  ],
  WithDecryption: true, // decrypt secure string parameters if they are encrypted
};


function getFormattedDate() {
  const today = new Date();

  // Get year, month, and day components
  const year = today.getFullYear();
  const month = String(today.getMonth() + 1).padStart(2, '0'); // Months are zero-based
  const day = String(today.getDate()).padStart(2, '0');

  // Format the date as 'YYYY-MM-DD'
  return `${year}-${month}-${day}`;
}

async function getRussell1000Tickers() {
  const russell1000Tickers = [];
  const today = getFormattedDate()
  const russell1000TickersPage = await fetch('https://en.wikipedia.org/wiki/Russell_1000_Index');
  const russell1000TickersPageHtml = await russell1000TickersPage.text();
  const $ = cheerio.load(russell1000TickersPageHtml);
  $('table.wikitable.sortable tbody tr').each((index, row) => {
    if (index === 0 ) return;
    const columns = $(row).find('td');
    const rowData = {
      rank: index,
      company: $(columns[0]).text().trim(),
      date: today,
      ticker: $(columns[1]).text().trim(),
      gisc_selector: $(columns[2]).text().trim(),
      gisc_sub_industry: $(columns[3]).text().trim(),
    };
    russell1000Tickers.push(rowData);
  });

  return russell1000Tickers;
}


function getOauthHeaders(url, api_key, api_secret, request_options_data = new Map(), token = null) {
  var oauth = OAuth({
    consumer: { 
      key: api_key, 
      secret: api_secret,
    },
    nonce_length: 11, 
    signature_method: 'HMAC-SHA1',
    hash_function(base_string, key) {
      return crypto.createHmac('sha1', key).update(base_string).digest('base64');
    },
  });
  var request_data = {
    url: url,
    method: 'GET',
    data: request_options_data,
  };
  return oauth.toHeader(oauth.authorize(request_data, token));
}


async function getEtradeCredentials() {
  var base_url, api_key, api_secret, etrade_username, etrade_password;
  const data = await ssm.getParameters(ssmParams).promise()
  const parameters = data.Parameters;
  parameters.forEach(param => {
    switch (param.Name) {
      case config.aws.parameter_store.etrade_base_url_name:
        base_url = param.Value;
        break;
      case config.aws.parameter_store.etrade_api_key_name:
        api_key = param.Value;
        break;
      case config.aws.parameter_store.etrade_api_secret_name:
        api_secret = param.Value;
        break;
      case config.aws.parameter_store.etrade_username_name:
        etrade_username = param.Value;
        break;
      case config.aws.parameter_store.etrade_password_name:
        etrade_password = param.Value;
        break;
    }
  });
  return [base_url, api_key, api_secret, etrade_username, etrade_password];
}


async function getOauthTokenAndSecret(res, base_url, api_key, api_secret, etrade_username, etrade_password) {
  // 1. Get request token.
  console.log(' 1. start getting request token ............')
  var request_token_resp = await fetch(base_url + config.request_token_url, {
    method: 'GET',
    headers: getOauthHeaders(base_url + config.request_token_url, api_key, api_secret, {oauth_callback: 'oob'}),
  });
  var request_token_body = await request_token_resp.text();
  // Parse the body as URL encoded parameters
  const params = new URLSearchParams(request_token_body);
  if (!params || params.has('oauth_problem')) {  
    console.error('Get request token (step 1) error:' + request_token_body);
    res.status(500).send('Get request token (step 1) failed');
    return
  }
  // Get the value of oauth_token
  var oauth_token = params.get('oauth_token');
  var oauth_token_secret = params.get('oauth_token_secret');
  console.log(' 1. request token fetched!!!!!!!!!!!!')
  
  // 2. Authorize.
  console.log(' 2. start authorizing ............')
  const url = config.authorize_url + '?key=' + api_key + '&token=' + oauth_token;
  const browser = await playwright.launchChromium({headless: false});
  // const browser = await firefox.launch({headless: false});
  console.log('   2.1 browser launched')
  var context = await browser.newContext();
  context.addCookies([{
    name: 'JSESSIONID',
    domain: 'https://us.etrade.com',
    path: '/aip',
    value: '2E45FC5E8E0100F2EB1630DEFABABFD4.tomcat1',
    httpOnly: true,
    secure: true,
    expires: -1,
  }]);
  console.log('   2.2 new context created')
  const page = await context.newPage();
  console.log('   2.3 new page created')
  var verification_code;
  try {
    //  2.1 log on with username and password
    await page.goto(url);
    console.log('   2.4 go to url: ' + url)
    const username_input = await page.$('#USER');
    await username_input.fill(etrade_username);
    console.log('   2.5 filled with username')
    const password_input = await page.$('#password');
    await password_input.fill(etrade_password);
    console.log('   2.6 filled with password')
    await page.click('#mfaLogonButton');
    console.log('   2.7 clicked on logon button')
    
    await sleep(5*1000)
    function sleep(ms) {
      return new Promise((resolve) => {
        setTimeout(resolve, ms);
      });
    }
    const html = await page.content()
    console.log('=================== after log on: ===================');
    console.log(html)
    console.log('=================== page.url: ===================')
    console.log(page.url())

    //  2.2 authorize the app
    try {
      await page.waitForSelector('[type="submit"]', {timeout: 10*10000});
    } catch (err) {
      console.error('Log on page time out: ', err);
      res.status(500).send('Log on page time out');
      return
    }
    const checkbox_exist = await page.isVisible('#acceptTerms');
    if (checkbox_exist) {
      const agreement_checkbox = await page.getByRole('checkbox');
      await agreement_checkbox.check();
      console.log('   2.8 checked #acceptTerms checkbox')
    }
    await page.click('#acceptSubmit')
    console.log('   2.9 clicked on submit button')
    //  2.3 get the verification code from input text
    verification_code = await page.inputValue('input[type="text"]');
    console.log('   2.10 received verification code')
  }catch (err) {
    console.error('Error using playwright to authorize the app: ', err);
    res.status(500).send('Error using playwright to authorize the app');
    return
  } finally {
    if (browser !== null) {
      await browser.close();
      console.log('   2.11 browser closed')
    }
  }
  console.log(' 2. authorization success!!!!!!!!!!!!')

  // 3. Get access token.
  console.log(' 3. start getting access token............')
  const extra_headers = {
    'oauth_token': oauth_token,
    'oauth_verifier': verification_code,
  }
  const access_token_resp = await fetch(base_url + config.access_token_url, {
    method: 'GET',
    headers: getOauthHeaders(base_url + config.access_token_url, api_key, api_secret, extra_headers, {key: oauth_token, secret: oauth_token_secret}),
  });
  var access_token_body = await access_token_resp.text();
  const access_token_resp_status_code = await access_token_resp.status;
  if (access_token_resp_status_code != 200) {
    console.error('Get access token (step 3) failed:' + access_token_body);
    res.status(500).send('Get access token (step 3) failed');
    return
  }
  console.log(' 3. access token fetched!!!!!!!!!!!!')
  const access_token_params = new URLSearchParams(access_token_body);
  oauth_token = access_token_params.get('oauth_token');
  oauth_token_secret= access_token_params.get('oauth_token_secret');
  return [oauth_token, oauth_token_secret];
}



async function revokeOauthTokenAndSecret(res, base_url, api_key, api_secret, oauth_token, oauth_token_secret) {
  const extra_headers = {
    'oauth_token': oauth_token,
  }
  const revoke_access_token_resp = await fetch(base_url + config.revoke_access_token_url, {
    method: 'GET',
    headers: getOauthHeaders(base_url + config.revoke_access_token_url, api_key, api_secret, extra_headers, {key: oauth_token, secret: oauth_token_secret}),
  });
  var revoke_access_token_body = await revoke_access_token_resp.text();
  const revoke_access_token_resp_status_code = await revoke_access_token_resp.status;
  if (revoke_access_token_resp_status_code != 200) {
    console.error('Revoke access token (step 5) failed:' + revoke_access_token_body);
    res.status(500).send('Revoke access token (step 5) failed');
    return
  }
}


async function storeToDynamoDB(res, tickerData, ask_price, bid_price) {
  if (!tickerData || tickerData.ticker == '') {
    return;
  }
  const params = {
    TableName: config.aws.dynamo_db_table_name,
    Item: {
      ticker_name: tickerData.ticker,
      company_name: tickerData.company,
      date: tickerData.date,
      category: tickerData.gisc_selector,
      sub_category: tickerData.gisc_sub_industry,
      ask_price_cents: ask_price * 100,
      bid_price_cents: bid_price * 100,
    },
  };
  await dynamoDbClient.put(params, (err, data) => {
    if (err) {
      console.error('Error saving ticker and price to DynamoDB:', err);
      res.status(500).send('Error saving ticker and price to DynamoDB');
    } else {
      console.log('Successfully saved ticker and price to DynamoDB:\n' + data);
    }
  });
}

app.get("/russel1000tickers", async function (req, res) {
  getRussell1000Tickers().then((russell1000Tickers) => {
    res.json(russell1000Tickers);
  });
});

app.get("/saveRussell1000TickerPrice", async function (req, res) {
  console.log('start getting etrade credentials ............')
  const [base_url, api_key, api_secret, etrade_username, etrade_password] = await getEtradeCredentials();
  console.log('etrade credentials fetched!!!!!!!!!!!!')

  console.log('start getting oauth token and secret ............')
  const [oauth_token, oauth_token_secret] = await getOauthTokenAndSecret(res, base_url, api_key, api_secret, etrade_username, etrade_password);
  console.log('oauth token and secret fetched!!!!!!!!!!!!')


  russell1000Tickers = await getRussell1000Tickers();
  for (const tickerData of russell1000Tickers) {
    console.log('start getting quote info for ticker ' + tickerData.ticker + ', company name: ' + tickerData.company + ', category: ' + tickerData.company + ' ............')
    const extra_headers = {
      'oauth_token': oauth_token,
    }
    const get_quote_url = config.get_quote_url + '/' + tickerData.ticker
    const get_quote_resp = await fetch(base_url + get_quote_url, {
      method: 'GET',
      headers: getOauthHeaders(base_url + get_quote_url, api_key, api_secret, extra_headers, {key: oauth_token, secret: oauth_token_secret}),
    });
    var get_quote_resp_body = await get_quote_resp.text();
    var get_quote_resp_json;
    try {
      xml2js.parseString(get_quote_resp_body, (err, result) => {
        get_quote_resp_json = result['QuoteResponse']['QuoteData'][0]['All'][0];
        if (err) {
          throw err;
        } 
      });
    } catch (err) {
      console.error('Error parsing get_quote response XML:', err);
      continue;
    }
    console.log('quote info for ticker ' + tickerData.ticker + ' fetched!!!!!!!!!!!!')


    console.log('start storing ticker and price to DynamoDB ............')
    await storeToDynamoDB(res, tickerData, Number(get_quote_resp_json['ask'][0]), Number(get_quote_resp_json['bid'][0]))
    console.log('stored ticker and price to DynamoDB!!!!!!!!!!!!')
  }

  console.log('start revoking access token............')
  revokeOauthTokenAndSecret(res, base_url, api_key, api_secret, oauth_token, oauth_token_secret)
  console.log('access token REVOKED!!!!!!!!!!!!')

  res.json('success');
});

module.exports.handler = serverless(app);
