const path = require('path');
const express = require('express');
const fs = require('fs');
const child_process = require('child_process');
const os = require('os');
const rateLimiter = require('express-rate-limit');
const { https } = require('follow-redirects'); // Because node.js doesn't know how to follow headers
const youtube = require('scrape-youtube').default;

const decompress = require('decompress');
const decompressTarxz = require('decompress-tarxz');

const download_path = path.join(__dirname, "downloads");
const tools_path = path.join(__dirname, "tools");
const log_path = path.join(__dirname, "general.log");

const app = express();

// ===========================================
var timers = [];

app.set('trust proxy', 1);
app.use('/stream', express.static(download_path));

// Rate-limiter, like if y'all didn't think of flooding this
app.use(rateLimiter({
	max: 55,
	windowMs: 60000,
}));

app.get('/search', async (req, res) => {
	if(!req.query.query) return res.sendStatus(400);
	if(!req.query.max) req.query.max = 5;
	if(parseInt(req.query.max) <= 0 || parseInt(req.query.max) > 10) return res.sendStatus(400);

	const queryNormalized = req.query.query.replace('+', ' ');
	
	console.log(`[~Logging] ${getAddress(req.ip)} requested search results with query "${queryNormalized}"`);
	fs.appendFileSync(log_path, `[~] ${getAddress(req.ip)} requested search results with query "${queryNormalized}"\n`);

	try {
		var results = await youtube.search(queryNormalized);
	} catch(e) {
		res.sendStatus(500);
		console.error('[~] Caught exception while searching: ' + e.message);
		return fs.appendFileSync(log_path, `[~] Caught exception while searching: ${e.message}\n`);
	}

	if(!results.length) return res.sendStatus(404);

	var data = { results: [] };
	for(let i = 0; (i < results.length && i < parseInt(req.query.max)); i++) {
		if(results[i].type !== 'video' || results[i].duration > 1200) { req.query.max++; continue; }

		if(results[i].title.length >= 45)
				results[i].title = results[i].title.substring(0, 45) + "...";

		if(results[i].channel.name.length >= 15)
			results[i].channel.name = results[i].channel.name.substring(0, 45) + "...";

		data.results.push({ id: results[i].id, title: results[i].title, uploaded_by: results[i].channel.name, duration: results[i].duration });
	}

	return res.status(200).json(data);
});

app.get('/download/:videoid', (req, res) => {
	if(!req.params.videoid) return res.status(400);
	if(fs.existsSync(path.join(download_path, `${req.params.videoid}.mp3`))) {
		timers.forEach((timer) => {
			if(timer.id === req.params.videoid) {
				clearTimeout(timer.timerObject);
				timer.timerObject = setTimeout(async () =>
				{
					if(fs.existsSync(path.join(download_path, `${req.params.videoid}.mp3`))) {
						await fs.promises.unlink(path.join(download_path, `${req.params.videoid}.mp3`));
					}
					timers.forEach((timer, index) => { if(timer.id === req.params.videoid) timers.splice(index, 1); });
				}, 1500000);
				timer.updated = Date.now();
			}
		});
		return res.sendStatus(200);
	}

	console.log(`[~Logging] ${getAddress(req.ip)} requests download with ID ${req.params.videoid}`);
	fs.appendFileSync(log_path, `[~Logging] ${getAddress(req.ip)} requests download with ID ${req.params.videoid}\n`);

	var dnow = Date.now();

	child_process.exec(`${path.join(tools_path, os.platform() === 'win32' ? "youtube-dl.exe" : "./youtube-dl")} https://youtube.com/watch?v=${req.params.videoid} --no-playlist --force-ipv4 --extract-audio --audio-format mp3 -q -o \"${path.join(download_path, "%(id)s.%(ext)s")}\"`, (error, stdout, stderr) => {
		if(error) return res.status(500).send(error.message);

		let ping = Date.now() - dnow;
		console.log(`[~Logging] File requested by ${getAddress(req.ip)} with ID ${req.params.videoid} converted. Took ${ping} milliseconds.`);
		fs.appendFileSync(log_path, `[~Logging] File requested by ${getAddress(req.ip)} with ID ${req.params.videoid} converted. Took ${ping} milliseconds.\n`);

		res.sendStatus(200);

		const timer = setTimeout(async () =>
		{
			if(fs.existsSync(path.join(download_path, `${req.params.videoid}.mp3`))) {
				await fs.promises.unlink(path.join(download_path, `${req.params.videoid}.mp3`));
			}
			timers.forEach((timer, index) => { if(timer.id === req.params.videoid) timers.splice(index, 1); });
		}, 1500000);

		timers.push({ id: req.params.videoid, timerObject: timer, created: Date.now(), updated: undefined }); 
	});
});

app.listen(12345, async () => {
	console.log('[~] Started.');
	fs.appendFileSync(log_path, `[~] Started\n`);

	if(fs.existsSync(download_path)) {
		const files = await fs.promises.readdir(download_path);
		if(files.length) {
			for(const file of files)
				await fs.promises.unlink(path.join(download_path, file));
			console.log(`[~] Deleted ${files.length} cached file${files.length > 1 ? 's' : ''}.`);
		}
	} else {
		await fs.promises.mkdir(download_path);
	}

	if(!fs.existsSync(tools_path)) {
		try {
			await fs.promises.mkdir(tools_path);
		} catch(e) {
			throw e;
		}
	}

	switch(os.platform())
	{
		case "win32":
			if(!fs.existsSync(path.join(tools_path, "youtube-dl.exe"))) {
				console.log('[~] Couldn\'t find youtube-dl binaries. Downloading...');
				const ydl_wstream = fs.createWriteStream(path.join(tools_path, "youtube-dl.exe"));
				https.get("https://youtube-dl.org/downloads/latest/youtube-dl.exe", (response) => {
					response.pipe(ydl_wstream).on('finish', () => console.log('[~] youtube-dl binaries downloaded.'));
				});
			}

			if(!fs.existsSync(path.join(tools_path, "ffmpeg.exe"))) {
				console.log('[~] Couldn\'t find ffmpeg binaries. Downloading...');
				const ffmpeg_wstream = fs.createWriteStream(path.join(tools_path, "ffmpeg.zip"));
				https.get("https://ffmpeg.zeranoe.com/builds/win64/static/ffmpeg-20200802-b48397e-win64-static.zip", (response) => {
					response.pipe(ffmpeg_wstream).on('finish', async () => {
						await decompress(path.join(tools_path, 'ffmpeg.zip'));
						try {
							await fs.promises.unlink(path.join(tools_path, "ffmpeg.zip"));
							await fs.promises.writeFile(path.join(tools_path, "ffmpeg.exe"), await fs.promises.readFile(path.join(tools_path, "ffmpeg-20200802-b48397e-win64-static", "bin", "ffmpeg.exe")));
							await fs.promises.rmdir(path.join(tools_path, "ffmpeg-20200802-b48397e-win64-static"), { recursive: true });
						} catch(e) {
							console.error(e.message);
							await fs.promises.appendFile(log_path, `[ERROR] ${e.message}\n`);
							process.exit(1);
						}

						console.log('[~] ffmpeg binaries downloaded.');
					});
				});
			}
			break;
		case "linux":
			if(!fs.existsSync(path.join(tools_path, "youtube-dl"))) {
				console.log('[~] Couldn\'t find youtube-dl binaries. Downloading...');
				const ydl_wstream = fs.createWriteStream(path.join(tools_path, "youtube-dl"));
				https.get("https://youtube-dl.org/downloads/latest/youtube-dl", (response) => {
					response.pipe(ydl_wstream).on('finish', () => console.log('[~] youtube-dl binaries downloaded.'));
				});
			}

			if(!fs.existsSync(path.join(tools_path, "ffmpeg"))) {
				console.log('[~] Couldn\'t find ffmpeg binaries. Downloading...');
				const ffmpeg_wstream = fs.createWriteStream(path.join(tools_path, "ffmpeg.tar.xz"));
				https.get('https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz', (response) => {
					response.pipe(ffmpeg_wstream).on('finish', async () => {
						await decompress(path.join(tools_path, "ffmpeg.tar.xz"), tools_path, { plugins: [ decompressTarxz() ] });
						await fs.promises.unlink(path.join(tools_path, "ffmpeg.tar.xz"));
						// Copy file from decompressed folder to /tools
						await fs.promises.writeFile(path.join(tools_path, "ffmpeg"), await fs.promises.readFile(path.join(tools_path, "ffmpeg-4.3.1-amd64-static", "ffmpeg")));
						await fs.promises.rmdir(path.join(tools_path, "ffmpeg-4.3.1-adm64-static"), { recursive: true });
						console.log('[~] ffmpeg binaries downloaded.');
					});
				});
			}
			break;
		default:
			console.warn('[~] Current platform doesn\'t support automatic dependency downloading.');
			break;
	}
});

function getAddress(address) {
	if(["::1", "localhost", "127.0.0.1"].includes(address)) return "local address";
	else return address.slice(7);
}
