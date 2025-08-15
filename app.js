// app.js - Clean Production Version

const puppeteer = require("puppeteer");
const fs = require("fs");
const path = require("path");
const moment = require("moment-timezone");
const express = require("express");
const archiver = require("archiver");

const app = express();
const port = process.env.PORT || 8080;
const host = '0.0.0.0';

app.use(express.json());

// In-memory job storage
const jobs = {};

const allowedDistricts = {
  AHILYANAGAR: "19372", AKOLA: "19373", "AMRAVATI CITY": "19842", "AMRAVATI RURAL": "19374", BEED: "19377", BHANDARA: "19376",
  "BRIHAN MUMBAI CITY": "19378", BULDHANA: "19379", CHANDRAPUR: "19381", "CHHATRAPATI SAMBHAJINAGAR (RURAL)": "19375",
  "CHHATRAPATI SAMBHAJINAGAR CITY": "19409", DHARASHIV: "19391", DHULE: "19382", GADCHIROLI: "19403", GONDIA: "19845", HINGOLI: "19846",
  JALGAON: "19384", JALNA: "19380", KOLHAPUR: "19386", LATUR: "19405", "Mira-Bhayandar, Vasai-Virar Police Commissioner": "19411",
  "NAGPUR CITY": "19387", "NAGPUR RURAL": "19388", NANDED: "19389", NANDURBAR: "19844", "NASHIK CITY": "19408", "NASHIK RURAL": "19390",
  "NAVI MUMBAI": "19841", PALGHAR: "19371", PARBHANI: "19392", "PIMPRI-CHINCHWAD": "19847", "PUNE CITY": "19393", "PUNE RURAL": "19394",
  RAIGAD: "19385", "RAILWAY CHHATRAPATI SAMBHAJINAGAR": "19848", "RAILWAY MUMBAI": "19404", "RAILWAY NAGPUR": "19402", "RAILWAY PUNE": "19383",
  RATNAGIRI: "19395", SANGLI: "19396", SATARA: "19397", SINDHUDURG: "19406", "SOLAPUR CITY": "19410", "SOLAPUR RURAL": "19398",
  "THANE CITY": "19399", "THANE RURAL": "19407", WARDHA: "19400", WASHIM: "19843", YAVATMAL: "19401"
};

// Helper functions
function getJobDownloadPath(jobId) {
  return path.resolve(`./downloads/${jobId}`);
}

function ensureJobDownloadDir(jobId) {
  const jobDownloadPath = getJobDownloadPath(jobId);
  if (fs.existsSync(jobDownloadPath)) {
    fs.rmSync(jobDownloadPath, { recursive: true, force: true });
  }
  fs.mkdirSync(jobDownloadPath, { recursive: true });
  return jobDownloadPath;
}

function updateJobProgress(jobId, progress, details = {}) {
  if (jobs[jobId]) {
    jobs[jobId].progress = progress;
    jobs[jobId].lastUpdated = new Date();
    if (details.totalDownloaded !== undefined) jobs[jobId].totalDownloaded = details.totalDownloaded;
    if (details.currentPage !== undefined) jobs[jobId].currentPage = details.currentPage;
    if (details.processingSpeed !== undefined) jobs[jobId].processingSpeed = details.processingSpeed;
  }
}

function scheduleJobCleanup(jobId, delayMinutes = 30) {
  setTimeout(() => {
    if (jobs[jobId]) {
      try {
        const jobDownloadPath = getJobDownloadPath(jobId);
        if (fs.existsSync(jobDownloadPath)) fs.rmSync(jobDownloadPath, { recursive: true, force: true });
        if (jobs[jobId].zipPath && fs.existsSync(jobs[jobId].zipPath)) fs.unlinkSync(jobs[jobId].zipPath);
        delete jobs[jobId];
      } catch (error) {
        console.error(`Cleanup error for job ${jobId}: ${error.message}`);
      }
    }
  }, delayMinutes * 60 * 1000);
}

async function waitForDownloadedPdf(downloadDir, beforeSet, timeoutMs = 120000) {
  const start = Date.now();
  let lastSize = 0;
  let stableCount = 0;

  while (Date.now() - start < timeoutMs) {
    if (!fs.existsSync(downloadDir)) {
      await new Promise((r) => setTimeout(r, 1000));
      continue;
    }

    const files = fs.readdirSync(downloadDir).filter((f) => f.endsWith(".pdf") && !beforeSet.has(f));
    if (files.length > 0) {
      const latest = files.sort((a, b) => fs.statSync(path.join(downloadDir, b)).mtimeMs - fs.statSync(path.join(downloadDir, a)).mtimeMs)[0];
      const size = fs.statSync(path.join(downloadDir, latest)).size;

      if (size === lastSize) {
        stableCount++;
        if (stableCount >= 3) return latest;
      } else {
        stableCount = 0;
        lastSize = size;
      }
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return null;
}

async function extractAndDownloadFIRs(fromDate, toDate, districtCode, jobId) {
  const startTime = Date.now();
  let totalDownloaded = 0;
  
  try {
    updateJobProgress(jobId, "Setting up download directory...", { totalDownloaded });
    const jobDownloadPath = ensureJobDownloadDir(jobId);

    updateJobProgress(jobId, "Launching browser...", { totalDownloaded });
    const browser = await puppeteer.launch({
      headless: "new",
      args: [
        '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
        '--disable-gpu', '--single-process', '--disable-extensions',
        '--no-first-run', '--disable-background-networking'
      ]
    });

    try {
      const page = await browser.newPage();
      const client = await page.target().createCDPSession();
      
      try {
        await client.send("Browser.setDownloadBehavior", {
          behavior: "allow",
          downloadPath: path.resolve(jobDownloadPath)
        });
      } catch (e) {
        try {
          await client.send("Page.setDownloadBehavior", {
            behavior: "allow", 
            downloadPath: path.resolve(jobDownloadPath)
          });
        } catch (e2) {}
      }

      await page.goto("https://citizen.mahapolice.gov.in/Citizen/MH/PublishedFIRs.aspx", { waitUntil: "domcontentloaded" });
      
      await page.waitForSelector("#ContentPlaceHolder1_ucRecordView_ddlPageSize");
      await page.select("#ContentPlaceHolder1_ucRecordView_ddlPageSize", "50");

      await page.evaluate((fromDate, toDate) => {
        document.querySelector("#ContentPlaceHolder1_txtDateOfRegistrationFrom").value = fromDate;
        document.querySelector("#ContentPlaceHolder1_txtDateOfRegistrationTo").value = toDate;
      }, fromDate, toDate);

      await page.select("#ContentPlaceHolder1_ddlDistrict", districtCode);
      
      await Promise.all([
        page.click("#ContentPlaceHolder1_btnSearch"),
        page.waitForSelector("#ContentPlaceHolder1_gdvDeadBody", { visible: true, timeout: 60000 })
      ]);

      const targetSections = [
        "प्राण्‍यांचा छळ प्रतिबंधक अधिनियम, १९६०",
        "महाराष्‍ट्र प्राणी संरक्षण (सुधारणा)अधिनियम,१९९५",
        "महाराष्ट्र पशु संरक्षण अधिनियम, १९७६",
        "पशु संरक्षण अधिनियम, १९५१"
      ];

      let pageIndex = 1;
      let isLastPage = false;
      const seenFirstRowHashes = new Set();

      while (!isLastPage) {
        updateJobProgress(jobId, `Processing page ${pageIndex}...`, { currentPage: pageIndex, totalDownloaded });
        
        const firData = await page.evaluate(() => {
          const rows = Array.from(document.querySelectorAll("#ContentPlaceHolder1_gdvDeadBody tr"));
          return rows.map((row) => {
            const cells = Array.from(row.querySelectorAll("td"));
            return {
              data: cells.map((cell) => cell.innerText.trim()),
              downloadSelector: cells[cells.length - 1]?.querySelector("input")?.getAttribute("id") || null
            };
          }).filter((row) => row.data.length === 10);
        });

        if (firData.length === 0) {
          isLastPage = true;
          break;
        }

        const firstRowKey = JSON.stringify(firData[0]);
        if (seenFirstRowHashes.has(firstRowKey)) {
          isLastPage = true;
        } else {
          seenFirstRowHashes.add(firstRowKey);
        }

        for (const [index, fir] of firData.entries()) {
          try {
            const sectionText = (fir.data[8] || "") + " " + (fir.data[1] || "");
            const matches = targetSections.some((s) => sectionText.includes(s));
            
            if (!matches || !fir.downloadSelector) continue;

            updateJobProgress(jobId, `Downloading file ${totalDownloaded + 1}...`, { currentPage: pageIndex, totalDownloaded });
            
            const filesBefore = new Set(fs.readdirSync(jobDownloadPath));
            await page.click(`#${fir.downloadSelector}`);
            
            const downloadedFile = await waitForDownloadedPdf(jobDownloadPath, filesBefore, 60000);

            if (downloadedFile) {
              // Original filename logic with safety
              const firNumber = (fir.data[7] || "").split("/");
              const rawName = `${fir.data}_${fir.data}_${fir.data}_${firNumber}_${fir.data}`;
              let safeFileName = rawName.replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ');
              
              // Prevent filename too long
              const MAX_BYTES = 240;
              while (Buffer.byteLength(safeFileName, 'utf8') > MAX_BYTES) {
                const idx = safeFileName.lastIndexOf('_');
                if (idx === -1) break;
                safeFileName = safeFileName.slice(0, idx);
              }

              const newFileName = `${safeFileName}.pdf`;
              let finalPath = path.join(jobDownloadPath, newFileName);
              let n = 1;
              while (fs.existsSync(finalPath)) {
                const ext = path.extname(newFileName);
                const base = path.basename(newFileName, ext);
                finalPath = path.join(jobDownloadPath, `${base}(${n})${ext}`);
                n++;
              }
              
              fs.renameSync(path.join(jobDownloadPath, downloadedFile), finalPath);
              totalDownloaded++;
              
              updateJobProgress(jobId, `Downloaded ${totalDownloaded} files`, { currentPage: pageIndex, totalDownloaded });
            }
            
            await new Promise(r => setTimeout(r, 500));
          } catch (err) {
            console.error(`Error processing FIR: ${err.message}`);
          }
        }

        pageIndex++;
        const pageClicked = await page.evaluate((nextIndex) => {
          const links = Array.from(document.querySelectorAll(".gridPager a"));
          let target = links.find((l) => l.innerText.trim() === String(nextIndex));
          if (!target) {
            const dots = [...links].reverse().find((l) => l.innerText.trim() === "...");
            if (dots) {
              dots.click();
              return "dots";
            }
            return false;
          }
          target.click();
          return true;
        }, pageIndex);

        if (!pageClicked) {
          isLastPage = true;
          break;
        }

        await page.waitForSelector("#ContentPlaceHolder1_gdvDeadBody", { visible: true, timeout: 30000 });
      }

      await page.close();
      await browser.close();
      
    } catch (err) {
      if (browser) await browser.close().catch(() => {});
      throw err;
    }

    updateJobProgress(jobId, `Creating ZIP with ${totalDownloaded} files...`, { totalDownloaded });
    const zipFilePath = path.join(__dirname, `downloaded_firs_${jobId}.zip`);
    
    await new Promise((resolve, reject) => {
      const output = fs.createWriteStream(zipFilePath);
      const archive = archiver("zip", { zlib: { level: 9 } });
      output.on("close", resolve);
      archive.on("error", reject);
      archive.pipe(output);
      archive.directory(jobDownloadPath, false);
      archive.finalize();
    });

    return zipFilePath;

  } catch (error) {
    throw error;
  }
}

// Static files
app.use(express.static(path.join(__dirname, "public")));

// Routes
app.get('/', (req, res) => {
  const indexPath = path.join(__dirname, "public", "index.html");
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.status(404).send("Index file not found");
  }
});

app.post("/start-fir-job", async (req, res) => {
  const { fromDate, toDate, districtName } = req.body;

  if (!fromDate || !toDate || !districtName) {
    return res.status(400).json({ error: "Required parameters: fromDate, toDate, districtName" });
  }

  const dateFormat = "DD/MM/YYYY";
  if (!moment(fromDate, dateFormat, true).isValid() || !moment(toDate, dateFormat, true).isValid()) {
    return res.status(400).json({ error: "Invalid date format. Use DD/MM/YYYY." });
  }

  const fromDateMoment = moment.tz(fromDate, dateFormat, "Asia/Kolkata");
  const toDateMoment = moment.tz(toDate, dateFormat, "Asia/Kolkata");

  if (fromDateMoment.isAfter(toDateMoment)) {
    return res.status(400).json({ error: "'fromDate' should be before 'toDate'." });
  }

  if (toDateMoment.diff(fromDateMoment, "days") > 90) {
    return res.status(400).json({ error: "Date range should not exceed 90 days." });
  }

  const code = allowedDistricts[String(districtName).toUpperCase()];
  if (!code) {
    return res.status(400).json({ error: "Invalid district name." });
  }

  const userJobs = Object.values(jobs).filter(j => j.userIp === req.ip && (j.status === 'started' || j.status === 'running'));
  if (userJobs.length >= 1) {
    return res.status(429).json({ error: "Please wait for your current job to complete." });
  }

  const jobId = `job_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  
  jobs[jobId] = {
    id: jobId,
    status: 'started',
    progress: 'Initializing...',
    createdAt: new Date(),
    lastUpdated: new Date(),
    params: { fromDate, toDate, districtName, districtCode: code },
    totalDownloaded: 0,
    currentPage: 0,
    userIp: req.ip
  };

  extractAndDownloadFIRs(fromDate, toDate, code, jobId)
    .then(zipPath => {
      jobs[jobId].status = 'completed';
      jobs[jobId].progress = `Completed! Downloaded ${jobs[jobId].totalDownloaded} files.`;
      jobs[jobId].zipPath = zipPath;
      jobs[jobId].completedAt = new Date();
      scheduleJobCleanup(jobId, 30);
    })
    .catch(error => {
      jobs[jobId].status = 'failed';
      jobs[jobId].progress = `Failed: ${error.message}`;
      scheduleJobCleanup(jobId, 5);
    });

  res.json({
    jobId,
    status: 'started',
    message: 'Job started successfully.'
  });
});

app.get("/job-status/:jobId", (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job) return res.status(404).json({ error: 'Job not found' });
  
  res.json({
    id: job.id,
    status: job.status,
    progress: job.progress,
    totalDownloaded: job.totalDownloaded || 0,
    currentPage: job.currentPage || 0,
    createdAt: job.createdAt,
    lastUpdated: job.lastUpdated
  });
});

app.get("/download-job-zip/:jobId", (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job) return res.status(404).send("Job not found.");
  if (job.status !== 'completed') return res.status(400).send("Job not completed.");
  if (!job.zipPath || !fs.existsSync(job.zipPath)) return res.status(404).send("ZIP file not found.");
  
  res.download(job.zipPath, `animal_protection_firs_${job.params.districtName.replace(/ /g, '_')}_${job.params.fromDate.replace(/\//g, '-')}_to_${job.params.toDate.replace(/\//g, '-')}.zip`);
});

// Cleanup old jobs every 2 hours
setInterval(() => {
  const now = new Date();
  const maxAge = 2 * 60 * 60 * 1000;
  Object.keys(jobs).forEach(jobId => {
    const job = jobs[jobId];
    if (now - job.createdAt > maxAge) {
      const jobDownloadPath = getJobDownloadPath(jobId);
      if (fs.existsSync(jobDownloadPath)) fs.rmSync(jobDownloadPath, { recursive: true, force: true });
      if (job.zipPath && fs.existsSync(job.zipPath)) fs.unlinkSync(job.zipPath);
      delete jobs[jobId];
    }
  });
}, 2 * 60 * 60 * 1000);

// Create directories
const baseDownloadsPath = path.resolve("./downloads");
if (!fs.existsSync(baseDownloadsPath)) {
  fs.mkdirSync(baseDownloadsPath, { recursive: true });
}

// Start server
app.listen(port, host, () => {
  console.log(`Server running on ${host}:${port}`);
});
