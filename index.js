import 'dotenv/config';
import fs from 'fs';
import Parser from 'rss-parser';
import { GoogleGenAI, Type } from '@google/genai';
import { chromium } from 'playwright';
import { v2 as cloudinary } from 'cloudinary';

const parser = new Parser();
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY.trim() });

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME.trim(),
  api_key: process.env.CLOUDINARY_API_KEY.trim(),
  api_secret: process.env.CLOUDINARY_API_SECRET.trim(),
});

const GRAPH_VERSION = 'v22.0';

const args = process.argv.slice(2);
const rawNicheArg = (args.find((a) => a.startsWith('--niche=')) || '').split('=')[1]?.toLowerCase();
const activeNiche = rawNicheArg === 'ipl' ? 'cricket' : (rawNicheArg || 'general');

const DB_FILE = `./posted-${activeNiche}.json`;
const LOCAL_JPG = `./latest_news-${activeNiche}.jpg`;

const NICHE_FEEDS = [
  {
    key: 'tech',
    niche: 'Tech & AI',
    url: 'https://news.google.com/rss/headlines/section/topic/TECHNOLOGY?hl=en-IN&gl=IN&ceid=IN:en',
  },
  {
    key: 'cricket',
    niche: 'Upcoming IPL & Cricket',
    url: 'https://news.google.com/rss/search?q=%22IPL+2027%22+OR+%22TATA+IPL+2027%22+OR+%22IPL+auction%22+when:2d&hl=en-IN&gl=IN&ceid=IN:en',
  },
  {
    key: 'cricket',
    niche: 'International Cricket',
    url: 'https://news.google.com/rss/search?q=%22Indian+cricket+team%22+OR+%22Team+India%22+OR+%22ICC%22+cricket+when:1d&hl=en-IN&gl=IN&ceid=IN:en',
  },
  {
    key: 'tech',
    niche: 'Tech & AI',
    url: 'https://news.google.com/rss/search?q=AI+smartphones+gadgets+tech+launch+India+when:2d&hl=en-IN&gl=IN&ceid=IN:en',
  },
  {
    key: 'viral',
    niche: 'Top Viral India',
    url: 'https://news.google.com/rss?hl=en-IN&gl=IN&ceid=IN:en',
  },
];

const FEEDS_BY_NICHE = {
  tech: NICHE_FEEDS.filter((f) => f.key === 'tech'),
  cricket: NICHE_FEEDS.filter((f) => f.key === 'cricket'),
  viral: NICHE_FEEDS.filter((f) => f.key === 'viral'),
};

function isFreshRelevantArticle(item, feedKey) {
  const title = (item.title || '').toLowerCase();

  if (feedKey === 'cricket') {
    if (/\bipl\s*(2020|2021|2022|2023|2024|2025|2026)\b/i.test(title)) return false;
  }

  if (!item.pubDate) return false;
  const publishedMs = new Date(item.pubDate).getTime();
  if (Number.isNaN(publishedMs)) return false;

  const ageHours = (Date.now() - publishedMs) / (1000 * 60 * 60);
  return ageHours >= -1 && ageHours <= 36;
}

function getState() {
  if (!fs.existsSync(DB_FILE)) return { links: [], turn: 0 };
  const raw = JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
  if (Array.isArray(raw)) return { links: raw, turn: 0 };
  return { links: raw.links || [], turn: raw.turn || 0 };
}

function saveState(state) {
  fs.writeFileSync(
    DB_FILE,
    JSON.stringify({ links: state.links.slice(-500), turn: state.turn }, null, 2)
  );
}

function findTemplateFile() {
  for (const name of ['Template.png', 'template.png', 'Template.jpg', 'template.jpg']) {
    if (fs.existsSync(`./${name}`)) return `./${name}`;
  }
  throw new Error('Missing Template.png or Template.jpg in project root');
}

async function isValidDecodedImage(page, dataUri) {
  if (!dataUri || !dataUri.startsWith('data:image/')) return false;
  return await page.evaluate(async (src) => {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve(img.naturalWidth >= 800 && img.naturalHeight >= 600);
      img.onerror = () => resolve(false);
      img.src = src;
    });
  }, dataUri);
}

// Vision check: rejects wrong people/jerseys and split-screen collages before rendering
async function verifyImageMatchesHeadline(dataUri, headline, expectedSubject) {
  try {
    const match = dataUri.match(/^data:(image\/[a-zA-Z0-9+.-]+);base64,(.+)$/);
    if (!match) return false;
    const [, mimeType, base64Data] = match;

    const response = await ai.models.generateContent({
      model: 'gemini-3.5-flash-lite',
      contents: [
        {
          inlineData: {
            mimeType,
            data: base64Data,
          },
        },
        `Headline: "${headline}"
Expected main subject: "${expectedSubject}"

Does this image accurately match the headline and show the expected subject (not a different famous player/person, and not a split-screen multi-photo collage)?`,
      ],
      config: {
        systemInstruction:
          'You are a strict photo editor for a news page. Return match=false if the image is blurry, pixelated, low-resolution, a YouTube thumbnail with large background text/banners, a split-screen collage, has watermarks, or shows the wrong person/team.',
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            match: { type: Type.BOOLEAN },
            reason: { type: Type.STRING },
          },
          required: ['match', 'reason'],
        },
      },
    });

    const verdict = JSON.parse(response.text);
    if (!verdict.match) {
      console.log(`Rejected candidate image (${verdict.reason})`);
    }
    return Boolean(verdict.match);
  } catch (err) {
    console.error('Vision verification error:', err.message);
    return false;
  }
}

async function searchImageViaPlaywright(browser, query, headline) {
  const page = await browser.newPage({
    viewport: { width: 1280, height: 900 },
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  });

  try {
    const searchUrl = `https://www.bing.com/images/search?q=${encodeURIComponent(
      query
    )}&qft=+filterui:imagesize-wallpaper&form=IRFLTR`;
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForTimeout(2500);

    const candidateUrls = await page.evaluate(() => {
      const results = [];
      const anchors = document.querySelectorAll('a.iusc');
      for (const a of anchors) {
        try {
          const meta = JSON.parse(a.getAttribute('m') || '{}');
          if (meta.murl && meta.murl.startsWith('http')) {
            results.push(meta.murl);
          }
        } catch {}
        if (results.length >= 12) break;
      }
      return results;
    });

    for (const imgUrl of candidateUrls) {
      try {
        const response = await page.request.get(imgUrl, { timeout: 7000 });
        if (!response.ok()) continue;
        const contentType = response.headers()['content-type'] || '';
        if (!contentType.startsWith('image/')) continue;

        const buffer = await response.body();
        if (buffer.length < 60000) continue;

        const dataUri = `data:${contentType.split(';')[0]};base64,${buffer.toString('base64')}`;
        if (!(await isValidDecodedImage(page, dataUri))) continue;

        if (await verifyImageMatchesHeadline(dataUri, headline, query)) {
          return dataUri;
        }
      } catch {}
    }
  } catch (err) {
    console.error('Image search error:', err.message);
  } finally {
    await page.close();
  }

  return '';
}

async function generateNewsCopy(title, snippet, niche) {
  const response = await ai.models.generateContent({
    model: 'gemini-3.5-flash-lite',
    contents: `Turn this ${niche} news into a high-engagement Instagram post.
Article Title: ${title}
Details: ${snippet}`,
    config: {
      systemInstruction:
        'You run a viral Indian Tech, Upcoming IPL 2027 & International Cricket, and Trending India Instagram page. Never frame old 2026 IPL match results as breaking news. Return: 1) cardHeadline: bold punchy headline (max 9 words, no emojis), 2) cardSummary: informative 2-3 sentence news summary (26 to 34 words) for the graphic card, 3) imageKeyword: exact full name of the primary person, product, or event in the headline plus 1 context word (e.g. "Paras Mhambrey cricket coach", "Apple iPhone 18 launch")—never use vague team-only queries that return unrelated players, and 4) caption: engaging 2-sentence Instagram caption ending with a debate question for comments, followed by 4 niche hashtags plus #eviwibe.',
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          cardHeadline: { type: Type.STRING, description: 'Max 9 words bold headline' },
          cardSummary: { type: Type.STRING, description: '26 to 34 words summary content' },
          imageKeyword: { type: Type.STRING, description: 'Exact primary person/product name + 1 context word' },
          caption: { type: Type.STRING, description: 'Instagram caption with hashtags including #eviwibe' },
        },
        required: ['cardHeadline', 'cardSummary', 'imageKeyword', 'caption'],
      },
    },
  });

  const data = JSON.parse(response.text);
  const cleanedCaption = data.caption.replace(/#eviwibe/gi, '').trim();
  data.caption = `${cleanedCaption} #eviwibe`;
  return data;
}

async function renderNewsCard(browser, { cardHeadline, cardSummary, articleImageBase64 }, outputPath) {
  const templatePath = findTemplateFile();
  const mime = templatePath.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
  const rawTemplateBase64 = `data:${mime};base64,${fs.readFileSync(templatePath).toString('base64')}`;

  const page = await browser.newPage({ viewport: { width: 1080, height: 1350 } });
  try {
    const logoAndFooterOverlay = await page.evaluate(async (src) => {
      return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
          const canvas = document.createElement('canvas');
          canvas.width = 1080;
          canvas.height = 1350;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, 1080, 1350);
          const frame = ctx.getImageData(0, 0, 1080, 1350);
          const d = frame.data;

          for (let y = 0; y < 1350; y++) {
            for (let x = 0; x < 1080; x++) {
              const i = (y * 1080 + x) * 4;
              const r = d[i], g = d[i + 1], b = d[i + 2];
              const isRedLogo = y < 280 && x < 280 && r > 140 && g < 90 && b < 90;
              const isBottomLinks = y > 1215;

              if (!isRedLogo && !isBottomLinks) {
                d[i + 3] = 0;
              }
            }
          }
          ctx.putImageData(frame, 0, 0);
          resolve(canvas.toDataURL('image/png'));
        };
        img.src = src;
      });
    }, rawTemplateBase64);

    const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <style>
        * { box-sizing: border-box; margin: 0; padding: 0; font-family: 'Segoe UI', Arial, sans-serif; }
        body {
          width: 1080px;
          height: 1350px;
          position: relative;
          background: #000000;
          color: #ffffff;
          overflow: hidden;
        }
        .news-photo {
          position: absolute;
          inset: 0;
          width: 1080px;
          height: 1350px;
          object-fit: cover;
          object-position: center top;
          z-index: 1;
        }
        .dynamic-gradient {
          position: absolute;
          inset: 0;
          z-index: 2;
        }
        .template-elements {
          position: absolute;
          inset: 0;
          width: 1080px;
          height: 1350px;
          z-index: 3;
          pointer-events: none;
        }
        .content-box {
          position: absolute;
          bottom: 125px;
          left: 56px;
          right: 56px;
          text-align: center;
          z-index: 4;
          display: flex;
          flex-direction: column;
          align-items: center;
        }
        .headline {
          font-size: 54px;
          font-weight: 900;
          line-height: 1.14;
          color: #e21b1b;
          text-transform: uppercase;
          margin-bottom: 16px;
          text-shadow: 0 3px 18px rgba(0, 0, 0, 0.95);
        }
        .summary {
          font-size: 29px;
          font-weight: 600;
          line-height: 1.38;
          color: #ffffff;
          max-width: 960px;
          text-shadow: 0 2px 10px rgba(0, 0, 0, 0.9);
        }
      </style>
    </head>
    <body>
      <img class="news-photo" src="${articleImageBase64}" />
      <div class="dynamic-gradient" id="grad"></div>
      <img class="template-elements" src="${logoAndFooterOverlay}" />
      <div class="content-box" id="contentBox">
        <div class="headline">${cardHeadline}</div>
        <div class="summary">${cardSummary}</div>
      </div>
    </body>
    </html>`;

    await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 15000 });

    await page.evaluate(() => {
      const box = document.getElementById('contentBox');
      const grad = document.getElementById('grad');
      const rect = box.getBoundingClientRect();
      const textTopPercent = (rect.top / 1350) * 100;

      const fadeStart = Math.max(38, textTopPercent - 16).toFixed(1);
      const fadeMid = Math.max(46, textTopPercent - 6).toFixed(1);
      const solidBlack = Math.max(52, textTopPercent + 1).toFixed(1);

      grad.style.background = `linear-gradient(
        180deg,
        rgba(0, 0, 0, 0.12) 0%,
        rgba(0, 0, 0, 0) 25%,
        rgba(0, 0, 0, 0) ${fadeStart}%,
        rgba(0, 0, 0, 0.72) ${fadeMid}%,
        rgba(0, 0, 0, 1) ${solidBlack}%,
        rgba(0, 0, 0, 1) 100%
      )`;
    });

    await page.waitForTimeout(400);
    await page.screenshot({ path: outputPath, type: 'jpeg', quality: 92 });
  } finally {
    await page.close();
  }
}

async function uploadToPublicUrl(filePath) {
  const result = await cloudinary.uploader.upload(filePath, {
    folder: 'insta-news-bot',
    format: 'jpg',
  });
  return { url: result.secure_url, publicId: result.public_id };
}

async function publishToInstagram(imageUrl, caption) {
  const igUserId = process.env.IG_USER_ID.trim();
  const token = process.env.IG_ACCESS_TOKEN.trim();

  const createRes = await fetch(
    `https://graph.facebook.com/${GRAPH_VERSION}/${igUserId}/media`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        image_url: imageUrl,
        caption,
        access_token: token,
      }),
    }
  );
  const createData = await createRes.json();
  if (!createData.id) {
    throw new Error(`Container creation failed: ${JSON.stringify(createData)}`);
  }

  await new Promise((r) => setTimeout(r, 4000));

  const publishRes = await fetch(
    `https://graph.facebook.com/${GRAPH_VERSION}/${igUserId}/media_publish`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        creation_id: createData.id,
        access_token: token,
      }),
    }
  );
  const publishData = await publishRes.json();
  if (!publishData.id) {
    throw new Error(`Publish failed: ${JSON.stringify(publishData)}`);
  }

  return publishData.id;
}

async function checkAndPostNews() {
  const state = getState();
  const selectedPool = FEEDS_BY_NICHE[activeNiche] || NICHE_FEEDS;
  const orderedFeeds = Array.from({ length: selectedPool.length }, (_, i) =>
    selectedPool[(state.turn + i) % selectedPool.length]
  );

  const browser = await chromium.launch();
  let postedThisRun = false;

  try {
    for (const feedSource of orderedFeeds) {
      console.log(`[${new Date().toLocaleTimeString()}] Checking ${feedSource.niche} feed...`);
      const feed = await parser.parseURL(feedSource.url);
      const latestItems = feed.items.slice(0, 20);

      for (const item of latestItems) {
        if (!item.link || state.links.includes(item.link)) continue;
        if (!isFreshRelevantArticle(item, feedSource.key)) continue;

        try {
          console.log(`New [${feedSource.niche}] story: ${item.title}`);
          const copy = await generateNewsCopy(item.title, item.contentSnippet || '', feedSource.niche);
          const articleImageBase64 = await searchImageViaPlaywright(
            browser,
            copy.imageKeyword,
            copy.cardHeadline
          );

          if (!articleImageBase64) {
            console.log(`No vision-verified photo for "${copy.imageKeyword}" — skipping.`);
            continue;
          }
          console.log(`Vision-verified photo attached (${copy.imageKeyword}).`);

          await renderNewsCard(browser, { ...copy, articleImageBase64 }, LOCAL_JPG);

          const { url, publicId } = await uploadToPublicUrl(LOCAL_JPG);
          const mediaId = await publishToInstagram(url, copy.caption);

          console.log(`Published [${feedSource.niche}] to Instagram! Media ID: ${mediaId}`);
          state.links.push(item.link);
          state.turn = (state.turn + 1) % selectedPool.length;
          saveState(state);

          if (fs.existsSync(LOCAL_JPG)) fs.unlinkSync(LOCAL_JPG);
          await cloudinary.uploader.destroy(publicId);
          postedThisRun = true;
          break;
        } catch (err) {
          console.error('Error processing item:', err.message);
        }
      }

      if (postedThisRun) break;
    }
  } finally {
    if (!postedThisRun) {
      console.log(`No new unposted articles in [${activeNiche}] right now.`);
    }
    await browser.close();
  }
}

await checkAndPostNews();
if (args.includes('--loop')) {
  console.log('Waiting 1 hour for next post...');
  setInterval(checkAndPostNews, 60 * 60 * 1000);
} else {
  process.exit(0);
}

