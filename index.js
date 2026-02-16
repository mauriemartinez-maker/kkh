const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const axios = require('axios');
const cheerio = require('cheerio');
const url = require('url');

// !!! THIS IS YOUR VERCEL URL !!!
const PROXY_URL = "https://weatherapitest9921.vercel.app"; 

const manifest = {
    id: 'community.kisskh.unified',
    version: '7.3.6',
    name: "KissKH Videos + Spanish Subs",
    description: 'Videos and Spanish subtitles from KissKH',
    resources: ['stream', 'subtitles'],
    types: ['series', 'movie'],
    idPrefixes: ['tt'],
    catalogs: [] 
};

const builder = new addonBuilder(manifest);
const subtitleCache = new Map();

// --- HELPER FUNCTIONS ---

function fixSpanishChars(text) {
    return text
        .replace(/Ã¡/g, 'á').replace(/Ã©/g, 'é').replace(/Ã­/g, 'í')
        .replace(/Ã³/g, 'ó').replace(/Ãº/g, 'ú').replace(/Ã‘/g, 'Ñ')
        .replace(/Ã±/g, 'ñ').replace(/Â¿/g, '¿').replace(/Â¡/g, '¡')
        .replace(/Ã¼/g, 'ü');
}

async function findShowOnKissKH(showName) {
    try {
        const searchUrl = `https://kisskh.club/?s=${encodeURIComponent(showName)}`;
        const response = await axios.get(searchUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
        });
        const $ = cheerio.load(response.data);
        const results = [];

        $('.listupd article.bs').each((i, element) => {
            const link = $(element).find('a').first();
            const url = link.attr('href');
            const title = link.attr('title') || $(element).find('.tt h2').text();
            if (url && url.includes('/series/')) {
                results.push({
                    url: url,
                    title: title.trim(),
                    slug: url.replace('https://kisskh.club/series/', '').replace('/', '')
                });
            }
        });

        const exactMatch = results.find(r => 
            r.title.toLowerCase() === showName.toLowerCase() ||
            r.title.toLowerCase().startsWith(showName.toLowerCase())
        );

        return exactMatch || results[0] || null;
    } catch (e) {
        console.error(`Search error: ${e.message}`);
        return null;
    }
}

async function getEpisodePattern(showUrl) {
    try {
        const response = await axios.get(showUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
        });
        const $ = cheerio.load(response.data);
        const firstEpisodeLink = $('.eplister ul li a').first().attr('href');

        if (!firstEpisodeLink) return null;

        const urlParts = firstEpisodeLink.split('/').filter(p => p);
        const slug = urlParts[urlParts.length - 2];
        const episodeBase = urlParts[urlParts.length - 1];

        return {
            slug: slug,
            episodeBase: episodeBase,
            baseUrl: `https://kisskh.club/${slug}/${episodeBase}`
        };
    } catch (e) {
        console.error(`Error fetching show page: ${e.message}`);
        return null;
    }
}

function extractBlogIdsFromSettings(html) {
    const settingsRegex = /videoPlayerSettings\s*=\s*({.+?});/s;
    const match = html.match(settingsRegex);
    const defaultBlogIds = ["4279541129339784660", "5681251218610301606", "4930891644815837589", "8100659440703509286"];

    if (match) {
        try {
            const settings = JSON.parse(match[1]);
            if (settings.bloggerAPI && settings.bloggerAPI.blogId) {
                return settings.bloggerAPI.blogId;
            }
        } catch (e) {}
    }
    return defaultBlogIds;
}

function extractPostIdFromEpisodePage(html) {
    const postIdRegex = /<div[^>]*id="kisskh"[^>]*data-post-id="(\d+)"[^>]*>/;
    const match = html.match(postIdRegex);
    return match && match[1] ? match[1] : null;
}

async function tryAllBlogIds(blogIds, postId) {
    for (const blogId of blogIds) {
        const url = `https://www.blogger.com/feeds/${blogId}/posts/default/${postId}?alt=json`;
        try {
            const response = await axios.get(url, { timeout: 5000 });
            if (response.data && response.data.entry) {
                return response.data.entry.content.$t;
            }
        } catch (e) {}
    }
    return null;
}

function extractSubtitleUrls(content, episodeNum) {
    const subtitles = [];
    const episodes = content.split(';');

    for (const episodeData of episodes) {
        if (episodeData.includes(`/${episodeNum}.es.vtt`) || 
            episodeData.includes(`/${episodeNum}.spa.vtt`)) {

            const cloudinaryRegex = /(https?:\\?\/\\?\/res\.cloudinary\.com\\?\/[^\/]+\\?\/[^,\n]+\.vtt)/g;
            const matches = episodeData.match(cloudinaryRegex) || [];

            matches.forEach(url => {
                const cleanUrl = url.replace(/\\\//g, '/').replace(/["'\\]/g, '');
                if (cleanUrl.includes(`/${episodeNum}.es.vtt`) || 
                    cleanUrl.includes(`/${episodeNum}.spa.vtt`)) {
                    subtitles.push(cleanUrl);
                }
            });
        }
    }
    return subtitles;
}

function extractVideoUrl(content, episodeNum) {
    const segments = content.split(';');
    for (const segment of segments) {
        if (segment.includes(`/${episodeNum}.es.vtt`) || 
            segment.includes(`/${episodeNum}.spa.vtt`)) {
            
            const mp4Regex = /(https?:\\?\/\\?\/[^"'\s|]+\.mp4)/;
            const match = segment.match(mp4Regex);

            if (match && match[1]) {
                return match[1].replace(/\\\//g, '/');
            }
        }
    }
    return null;
}

async function getShowDetails(imdbId) {
    try {
        let url = `https://v3-cinemeta.strem.io/meta/series/${imdbId}.json`;
        let response = await axios.get(url);
        let year = response.data.meta.year || response.data.meta.releaseInfo;
        if (year) year = year.toString().split(/[-–]/)[0].trim();
        return { name: response.data.meta.name, year: year, imdbId: imdbId };
    } catch (e) {
        try {
            url = `https://v3-cinemeta.strem.io/meta/movie/${imdbId}.json`;
            response = await axios.get(url);
            return { name: response.data.meta.name, year: response.data.meta.year, imdbId: imdbId };
        } catch (e2) { return null; }
    }
}

// --- HANDLERS ---

builder.defineStreamHandler(async ({ type, id }) => {
    let imdbId, season, episode;
    if (type === 'series') {
        [imdbId, season, episode] = id.split(':');
    } else {
        imdbId = id;
        season = 1;
        episode = 1;
    }

    const details = await getShowDetails(imdbId);
    if (!details) return { streams: [] };

    const searchResult = await findShowOnKissKH(details.name);
    if (!searchResult) return { streams: [] };

    const episodePattern = await getEpisodePattern(searchResult.url);
    if (!episodePattern) return { streams: [] };

    const episodeNumStr = episode.toString().padStart(2, '0');
    const episodeUrl = `${episodePattern.baseUrl}/?server=02&episode=${episodeNumStr}`;

    try {
        const pageResponse = await axios.get(episodeUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
        });

        const postId = extractPostIdFromEpisodePage(pageResponse.data);
        if (!postId) return { streams: [] };

        const blogIds = extractBlogIdsFromSettings(pageResponse.data);
        const bloggerContent = await tryAllBlogIds(blogIds, postId);
        if (!bloggerContent) return { streams: [] };

        const videoUrl = extractVideoUrl(bloggerContent, episode);

        if (videoUrl) {
            return { streams: [{ url: videoUrl, title: 'KissKH 720p' }] };
        }
    } catch (e) {
        console.error(`Stream handler error: ${e.message}`);
    }

    return { streams: [] };
});

builder.defineSubtitlesHandler(async ({ type, id }) => {
    let imdbId, season, episode;
    if (type === 'series') {
        [imdbId, season, episode] = id.split(':');
    } else {
        imdbId = id;
        episode = 1;
    }

    const details = await getShowDetails(imdbId);
    if (!details) return { subtitles: [] };

    const cacheKey = `${details.name}-${episode}`;
    if (subtitleCache.has(cacheKey)) {
        return { subtitles: subtitleCache.get(cacheKey) };
    }

    const searchResult = await findShowOnKissKH(details.name);
    if (!searchResult) return { subtitles: [] };

    const episodePattern = await getEpisodePattern(searchResult.url);
    if (!episodePattern) return { subtitles: [] };

    const episodeNumStr = episode.toString().padStart(2, '0');
    const episodeUrl = `${episodePattern.baseUrl}/?server=02&episode=${episodeNumStr}`;

    try {
        const pageResponse = await axios.get(episodeUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
        });

        const postId = extractPostIdFromEpisodePage(pageResponse.data);
        if (!postId) return { subtitles: [] };

        const blogIds = extractBlogIdsFromSettings(pageResponse.data);
        const bloggerContent = await tryAllBlogIds(blogIds, postId);
        if (!bloggerContent) return { subtitles: [] };

        const subtitleUrls = extractSubtitleUrls(bloggerContent, episode);

        if (subtitleUrls.length > 0) {
            const subtitles = [];
            for (const url of subtitleUrls) {
                // PROXY CHANGE: We do NOT fetch here. We just return the proxy link.
                const proxyLink = `${PROXY_URL}/sub.vtt?from=${encodeURIComponent(url)}`;
                subtitles.push({
                    id: url,
                    url: proxyLink,
                    lang: 'spa',
                    label: 'Spanish (KissKH)'
                });
            }
            subtitleCache.set(cacheKey, subtitles);
            return { subtitles };
        }
    } catch (e) {
        console.error(`Subtitle handler error: ${e.message}`);
    }

    return { subtitles: [] };
});

// --- VERCEL EXPORT WITH PROXY & CORS ---
const router = getRouter(builder.getInterface());

module.exports = async (req, res) => {
    // 1. Force CORS headers on every request
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');

    // 2. Handle preflight requests
    if (req.method === 'OPTIONS') {
        res.statusCode = 200;
        res.end();
        return;
    }

    // 3. PROXY HANDLER: Intercept /sub.vtt requests
    const parsedUrl = url.parse(req.url, true);
    if (parsedUrl.pathname === '/sub.vtt') {
        const targetUrl = parsedUrl.query.from;
        if (!targetUrl) {
            res.statusCode = 400;
            res.end('Missing url');
            return;
        }

        try {
            // Fetch the original subtitle
            const response = await axios.get(targetUrl, { responseType: 'text', timeout: 10000 });
            // Fix the characters
            const fixedContent = fixSpanishChars(response.data);
            
            // Serve it as a file
            res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
            res.statusCode = 200;
            res.end(fixedContent);
        } catch (e) {
            res.statusCode = 500;
            res.end('Error fetching subtitle');
        }
        return;
    }

    // 4. Standard Stremio Router
    router(req, res, () => {
        res.statusCode = 404;
        res.end();
    });
};
