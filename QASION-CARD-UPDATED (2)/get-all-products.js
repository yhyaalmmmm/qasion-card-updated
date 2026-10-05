const fs = require("fs");

const tokens = {
  gift4card: process.env.GIFT4CARD_API_TOKEN,
  mega: process.env.MEGA_API_TOKEN,
  sw: process.env.SW_API_TOKEN
};

async function getJson(url, headers) {
  const res = await fetch(url, { headers });
  const text = await res.text();

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${text.substring(0, 500)}`);
  }

  return data;
}

async function main() {
  console.log("");
  console.log("==========================================");
  console.log(" QASION CARD - PRODUCTS EXPORT");
  console.log("==========================================");
  console.log("");

  const result = {
    exported_at: new Date().toISOString(),
    providers: {}
  };

  // =========================
  // Gift4Card
  // =========================

  console.log("1/3 Gift4Card...");

  if (!tokens.gift4card) {
    result.providers.gift4card = {
      success: false,
      error: "GIFT4CARD_API_TOKEN missing"
    };
  } else {
    try {
      const headers = {
        "api-token": tokens.gift4card,
        "Accept": "application/json"
      };

      const products = await getJson(
        "https://api.gift4card.com/client/api/products",
        headers
      );

      let content = null;

      try {
        content = await getJson(
          "https://api.gift4card.com/client/api/content/0",
          headers
        );
      } catch (e) {
        content = {
          error: e.message
        };
      }

      result.providers.gift4card = {
        success: true,
        products,
        content
      };

      console.log("   OK");
    } catch (e) {
      result.providers.gift4card = {
        success: false,
        error: e.message
      };

      console.log("   ERROR:", e.message);
    }
  }

  // =========================
  // Mega Game
  // =========================

  console.log("2/3 Mega Game...");

  if (!tokens.mega) {
    result.providers.mega = {
      success: false,
      error: "MEGA_API_TOKEN missing"
    };
  } else {
    try {
      const headers = {
        "apiToken": tokens.mega,
        "Accept": "application/json"
      };

      const products = await getJson(
        "https://mega-game.net/api/fastapi/products",
        headers
      );

      result.providers.mega = {
        success: true,
        products
      };

      console.log("   OK");
    } catch (e) {
      result.providers.mega = {
        success: false,
        error: e.message
      };

      console.log("   ERROR:", e.message);
    }
  }

  // =========================
  // SW Game
  // =========================

  console.log("3/3 SW Game...");

  if (!tokens.sw) {
    result.providers.sw = {
      success: false,
      error: "SW_API_TOKEN missing"
    };
  } else {
    try {
      const headers = {
        "apiToken": tokens.sw,
        "Accept": "application/json"
      };

      const products = await getJson(
        "https://sw-games.net/api/fastapi/products",
        headers
      );

      result.providers.sw = {
        success: true,
        products
      };

      console.log("   OK");
    } catch (e) {
      result.providers.sw = {
        success: false,
        error: e.message
      };

      console.log("   ERROR:", e.message);
    }
  }

  // =========================
  // Save
  // =========================

  const filename = "qasion-products-all.json";

  fs.writeFileSync(
    filename,
    JSON.stringify(result, null, 2),
    "utf8"
  );

  console.log("");
  console.log("==========================================");
  console.log(" DONE");
  console.log("==========================================");
  console.log("");
  console.log("تم إنشاء:");
  console.log(filename);
  console.log("");
}

main().catch((err) => {
  console.error("");
  console.error("FATAL ERROR:", err.message);
  process.exit(1);
});
