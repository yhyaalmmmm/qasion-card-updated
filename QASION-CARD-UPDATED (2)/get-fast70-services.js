const fs = require("fs");

const API_URL = "https://fast70.com/api/v2";
const API_KEY = process.env.FAST70_API_KEY;

if (!API_KEY) {
  console.error("ERROR: FAST70_API_KEY غير موجود.");
  console.error('نفذ أولاً: $env:FAST70_API_KEY="YOUR_KEY"');
  process.exit(1);
}

// كلمات تدل على خدمات الألعاب التي طلبنا استبعادها من Fast70
const GAME_KEYWORDS = [
  "pubg",
  "free fire",
  "freefire",
  "call of duty",
  "cod mobile",
  "fortnite",
  "clash of clans",
  "clash royale",
  "mobile legends",
  "league of legends",
  "valorant",
  "minecraft",
  "roblox",
  "steam",
  "xbox",
  "playstation",
  "psn",
  "nintendo",
  "razer gold",
  "game",
  "gaming",
  "gamer",
  "uc",
  "cp points",
  "diamonds",
  "coins game",
  "game credits"
];

function isGameService(service) {
  const text = [
    service.name,
    service.category,
    service.type
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  return GAME_KEYWORDS.some(keyword =>
    text.includes(keyword.toLowerCase())
  );
}

async function callFast70(action) {
  const body = new URLSearchParams({
    key: API_KEY,
    action
  });

  const response = await fetch(API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Accept": "application/json"
    },
    body
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${text}`);
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Fast70 returned invalid JSON:\n${text}`);
  }
}

function uniqueCategories(services) {
  return [...new Set(
    services
      .map(x => x.category)
      .filter(Boolean)
  )].sort((a, b) => a.localeCompare(b));
}

function platformGuess(service) {
  const text = [
    service.name,
    service.category,
    service.type
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  const platforms = [
    ["instagram", "Instagram"],
    ["insta", "Instagram"],
    ["tiktok", "TikTok"],
    ["tik tok", "TikTok"],
    ["youtube", "YouTube"],
    ["facebook", "Facebook"],
    ["telegram", "Telegram"],
    ["twitter", "Twitter/X"],
    ["x.com", "Twitter/X"],
    ["snapchat", "Snapchat"],
    ["spotify", "Spotify"],
    ["discord", "Discord"],
    ["reddit", "Reddit"],
    ["twitch", "Twitch"],
    ["linkedin", "LinkedIn"],
    ["pinterest", "Pinterest"],
    ["threads", "Threads"],
    ["soundcloud", "SoundCloud"]
  ];

  for (const [needle, name] of platforms) {
    if (text.includes(needle)) return name;
  }

  return "منصات أخرى";
}

(async () => {
  try {
    console.log("جاري جلب خدمات Fast70...");

    const services = await callFast70("services");

    if (!Array.isArray(services)) {
      console.error("الرد ليس قائمة خدمات:");
      console.dir(services, { depth: null });
      process.exit(1);
    }

    const normalized = services.map(service => ({
      service_id: service.service,
      name: service.name,
      type: service.type,
      category: service.category,
      rate: Number(service.rate),
      min: Number(service.min),
      max: Number(service.max),
      refill: Boolean(service.refill),
      cancel: Boolean(service.cancel),
      platform: platformGuess(service),
      is_game: isGameService(service),
      raw: service
    }));

    const nonGames = normalized.filter(x => !x.is_game);
    const games = normalized.filter(x => x.is_game);

    const categories = uniqueCategories(nonGames);

    const platforms = {};
    for (const service of nonGames) {
      if (!platforms[service.platform]) {
        platforms[service.platform] = 0;
      }
      platforms[service.platform]++;
    }

    const output = {
      exported_at: new Date().toISOString(),
      provider: "Fast70",
      api_url: API_URL,
      total_services: normalized.length,
      non_game_services: nonGames.length,
      excluded_game_services: games.length,
      categories,
      platforms,
      services: nonGames
    };

    fs.writeFileSync(
      "fast70-services-non-games.json",
      JSON.stringify(output, null, 2),
      "utf8"
    );

    fs.writeFileSync(
      "fast70-services-all.json",
      JSON.stringify(
        {
          exported_at: new Date().toISOString(),
          provider: "Fast70",
          total_services: normalized.length,
          services: normalized
        },
        null,
        2
      ),
      "utf8"
    );

    const csvHeader = [
      "service_id",
      "platform",
      "category",
      "name",
      "type",
      "rate",
      "min",
      "max",
      "refill",
      "cancel"
    ];

    const csvRows = nonGames.map(x =>
      csvHeader.map(key => {
        const value = x[key] ?? "";
        return `"${String(value).replace(/"/g, '""')}"`;
      }).join(",")
    );

    fs.writeFileSync(
      "fast70-services-non-games.csv",
      [csvHeader.join(","), ...csvRows].join("\n"),
      "utf8"
    );

    console.log("");
    console.log("========================================");
    console.log(" FAST70 SERVICES EXPORT");
    console.log("========================================");
    console.log(`كل الخدمات: ${normalized.length}`);
    console.log(`خدمات غير الألعاب: ${nonGames.length}`);
    console.log(`المستبعدة كألعاب: ${games.length}`);
    console.log("");
    console.log("المنصات:");
    for (const [platform, count] of Object.entries(platforms)) {
      console.log(`- ${platform}: ${count}`);
    }

    console.log("");
    console.log("الأقسام:");
    for (const category of categories) {
      console.log(`- ${category}`);
    }

    console.log("");
    console.log("تم إنشاء:");
    console.log("1. fast70-services-all.json");
    console.log("2. fast70-services-non-games.json");
    console.log("3. fast70-services-non-games.csv");
    console.log("");
    console.log("جاهز. ابعتلي ملف fast70-services-non-games.json.");
  } catch (error) {
    console.error("");
    console.error("FAST70 ERROR:");
    console.error(error.message);
    process.exit(1);
  }
})();
