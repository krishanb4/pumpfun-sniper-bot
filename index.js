import WebSocket from "ws";
import axios from "axios";
import TelegramBot from "node-telegram-bot-api";
import fs from "fs";
import { log } from "console";

// Load token data from JSON file or create an empty object
const tokenDataFile = "tokens.json";
let tokenData = {};
if (fs.existsSync(tokenDataFile)) {
  tokenData = JSON.parse(fs.readFileSync(tokenDataFile));
} else {
  fs.writeFileSync(tokenDataFile, JSON.stringify(tokenData, null, 2));
}

// Function to save token data to JSON file
const saveTokenData = () => {
  fs.writeFileSync(tokenDataFile, JSON.stringify(tokenData, null, 2));
};

// Telegram Bot Setup
const TELEGRAM_TOKEN = "7676654766:AAFP3n7pBecfac4zHELVrO10DIEVCjLjCiU"; // Replace with your Telegram bot token
const TELEGRAM_CHAT_ID = "-1002387235771"; // Replace with your Telegram group chat ID
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: false });

// WebSocket setup to receive token data
const ws = new WebSocket("wss://pumpportal.fun/api/data");

let tokenQueue = new Set();

ws.on("open", function open() {
  // Subscribing to token creation events
  let payload = {
    method: "subscribeNewToken",
  };
  ws.send(JSON.stringify(payload));
  console.log("Subscribed to new token events.");
});

ws.on("message", function message(data) {
  try {
    const parsedData = JSON.parse(data);
    const { uri, name, mint, traderPublicKey } = parsedData;

    // Save token data and add to queue if not already processed
    if (!tokenData[mint]) {
      tokenData[mint] = {
        uri,
        name,
        mint,
        traderPublicKey,
        checked: false,
      };
      tokenQueue.add(mint);
      saveTokenData();
    }
  } catch (error) {
    console.error("Error processing WebSocket message:", error.message);
  }
});

ws.on("error", (err) => {
  console.error("WebSocket error:", err.message);
});

ws.on("close", () => {
  console.log("WebSocket connection closed.");
});

// Function to check token safety using RugCheck API
const checkTokenSafety = async (mintAddresses) => {
  const RUGCHECK_API_KEY =
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJleHAiOjE3MzI5Njg4NjQsImlkIjoiNENCaW1aNnZZbmJ4YnRMMk1QVEVHcFFTamU4UnlkSFFOV25DWnZ6eDNWcUQifQ.1pD6C45t7jwy4paB335RD-mw4m0PXsG9jWuJKc_0qxU"; // Replace with your RugCheck API key

  for (const mintAddress of mintAddresses) {
    if (tokenData[mintAddress] && tokenData[mintAddress].checked) {
      console.log(`Token ${mintAddress} already checked. Skipping.`);
      continue;
    }

    try {
      const response = await axios.get(
        `https://api.rugcheck.xyz/v1/tokens/${mintAddress}/report`,
        {
          headers: {
            Authorization: `Bearer ${RUGCHECK_API_KEY}`,
          },
        }
      );
      console.log(`Token safety checked for ${mintAddress}.`);

      const safetyReport = response.data;

      tokenData[mintAddress].checked = true;
      tokenData[mintAddress].safetyReport = safetyReport;
      saveTokenData();

      // Analyze the token for buying decision
      analyzeTokenForPurchase(tokenData[mintAddress]);
    } catch (error) {
      if (error.response) {
        // Provide detailed error information
        console.error(
          `Failed to check token safety: Status Code ${
            error.response.status
          }, Data: ${JSON.stringify(error.response.data)}`
        );
      } else if (error.request) {
        console.error(
          `Failed to check token safety: No response received, Request: ${error.request}`
        );
      } else {
        console.error(`Failed to check token safety: ${error.message}`);
      }
    }
  }
};

// Function to analyze token for purchase decision
const analyzeTokenForPurchase = (token) => {
  const { safetyReport, name, mint } = token;

  if (!safetyReport) {
    console.log(`No safety report available for token ${mint}`);
    return;
  }

  const { topHolders, totalMarketLiquidity, score } = safetyReport;

  let isGoodToBuy = true;
  let risks = [];

  // Remove bonding curve address (always at the top of the holders list)
  const filteredHolders = topHolders.slice(1);

  // Check if the top 10 remaining holders collectively hold more than 30% of the token supply
  const topTenHolders = filteredHolders.slice(0, 10);
  const totalPercentageHeld = topTenHolders.reduce(
    (sum, holder) => sum + holder.pct,
    0
  );
  if (totalPercentageHeld > 30) {
    isGoodToBuy = false;
    risks.push(
      `Top 10 holders collectively hold more than 30% of the token supply (${totalPercentageHeld}%)`
    );
  }

  // Check liquidity
  if (totalMarketLiquidity < 10000) {
    isGoodToBuy = false;
    risks.push("Low liquidity (< $10,000)");
  }

  // Check risk score
  if (score > 500) {
    isGoodToBuy = false;
    risks.push("High risk score (> 500)");
  }

  // Only consider the token a good buy if all conditions are met
  if (
    isGoodToBuy &&
    totalMarketLiquidity >= 10000 &&
    score <= 500 &&
    totalPercentageHeld <= 30
  ) {
    console.log(`Token ${name} (${mint}) is considered a good buy.`);

    // Send Telegram message with analysis for good tokens only
    let telegramMessage = `Token: ${name}\nMint Address: \<code>${mint}</code>\n✅ This token is considered a good buy.`;
    bot.sendMessage(TELEGRAM_CHAT_ID, telegramMessage, {
      parse_mode: "HTML",
    });
  } else {
    console.log(
      `Token ${name} (${mint}) is NOT recommended for purchase due to the following risks:`
    );

    risks.forEach((risk) => console.log(`- ${risk}`));
  }
};

// Function to periodically check tokens for risks from the queue
const periodicRugCheck = () => {
  setInterval(async () => {
    console.log("Running periodic rug check...");
    if (tokenQueue.size === 0) {
      return;
    }

    const tokensToCheck = Array.from(tokenQueue).slice(0, 3); // Limit the number of tokens to check at a time
    tokenQueue = new Set([...tokenQueue].slice(3)); // Remove checked tokens from the queue

    await checkTokenSafety(tokensToCheck);
  }, 15000); // Check every 10 seconds
};

// Start periodic rug check
periodicRugCheck();
