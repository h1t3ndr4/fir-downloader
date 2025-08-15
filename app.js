// app.js

const puppeteer = require("puppeteer");
const fs = require("fs");
const path = require("path");
const moment = require("moment-timezone");
const express = require("express");
const archiver = require("archiver");

const app = express();
const port = process.env.PORT || 8080;
const host = process.env.HOST || '0.0.0.0';

// Add JSON parsing middleware
app.use(express.json());

// In-memory job storage (use Redis in production)
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

// Helper functions for job-specific directories
function getJobDownloadPath(jobId) {
  return path.resolve(`./downloads/${jobId}`);
}

function ensureJobDownloadDir(jobId) {
  const jobDownloadPath = getJobDownloadPath(jobId);
  console.log(`📁 Ensuring download directory for job ${jobId}...`);
  
  if (fs.existsSync(jobDownloadPath)) {
    console.log(`🗑️ Removing existing job directory: ${jobDownloadPath}`);
    fs.rmSync(jobDownloadPath, { recursive: true, force: true });
  }
  
  fs.mkdirSync(jobDownloadPath, { recursive: true });
  console.log(`✅ Job download directory ready: ${jobDownloadPath}`);
  return jobDownloadPath;
}

function safe(name) {
  return String(name)
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, " ")
    .trim();
}

function updateJobProgress(jobId, progress, details = {}) {
  if (jobs[jobId]) {
    jobs[jobId].progress = progress;
    jobs[jobId].lastUpdated = new Date();
    if (details.totalDownloaded !== undefined) {
      jobs[jobId].totalDownloaded = details.totalDownloaded;
    }
    if (details.currentPage !== undefined) {
      jobs[jobId].currentPage = details.currentPage;
    }
    if (details.totalPages !== undefined) {
      jobs[jobId].totalPages = details.totalPages;
    }
    if (details.estimatedTimeRemaining !== undefined) {
      jobs[jobId].estimatedTimeRemaining = details.estimatedTimeRemaining;
    }
    if (details.processingSpeed !== undefined) {
      jobs[jobId].processingSpeed = details.processingSpeed;
    }
    console.log(`📊 Job ${jobId}: ${progress}`);
  }
}

// Schedule automatic cleanup after successful download
function scheduleJobCleanup(jobId, delayMinutes = 30) {
  console.log(`⏰ Scheduling cleanup for job ${jobId} in ${delayMinutes} minutes`);
  
  setTimeout(() => {
    if (jobs[jobId]) {
      try {
        // Delete job directory
        const jobDownloadPath = getJobDownloadPath(jobId);
        if (fs.existsSync(jobDownloadPath)) {
          fs.rmSync(jobDownloadPath, { recursive: true, force: true });
          console.log(`🗑️ Auto-deleted job directory: ${jobDownloadPath}`);
        }
        
        // Delete ZIP file
        if (jobs[jobId].zipPath && fs.existsSync(jobs[jobId].zipPath)) {
          fs.unlinkSync(jobs[jobId].zipPath);
          console.log(`🗑️ Auto-deleted ZIP file: ${jobs[jobId].zipPath}`);
        }
        
        // Remove from jobs tracking
        delete jobs[jobId];
        console.log(`🗑️ Auto-cleaned job: ${jobId} after ${delayMinutes} minutes`);
        
      } catch (error) {
        console.error(`❌ Error during scheduled cleanup of job ${jobId}: ${error.message}`);
      }
    }
  }, delayMinutes * 60 * 1000); // Convert minutes to milliseconds
}

async function waitForDownloadedPdf(downloadDir, beforeSet, timeoutMs = 120000) {
  console.log(`⏳ Waiting for PDF download in: ${downloadDir}...`);
  const start = Date.now();
  let lastSize = 0;
  let stableCount = 0;

  while (Date.now() - start < timeoutMs) {
    if (!fs.existsSync(downloadDir)) {
      console.log(`📁 Download directory doesn't exist yet: ${downloadDir}`);
      await new Promise((r) => setTimeout(r, 1000));
      continue;
    }

    const files = fs
      .readdirSync(downloadDir)
      .filter((f) => f.endsWith(".pdf") && !beforeSet.has(f));

    if (files.length > 0) {
      const latest = files.sort(
        (a, b) =>
          fs.statSync(path.join(downloadDir, b)).mtimeMs -
          fs.statSync(path.join(downloadDir, a)).mtimeMs
      )[0];
      const full = path.join(downloadDir, latest);
      const size = fs.statSync(full).size;

      console.log(`📄 Found file: ${latest} (${size} bytes)`);

      if (size === lastSize) {
        stableCount += 1;
        console.log(`⏱️ File size stable for ${stableCount} checks`);
      } else {
        stableCount = 0;
        lastSize = size;
        console.log(`📈 File size changed to ${size} bytes`);
      }

      if (stableCount >= 3) {
        console.log(`✅ File download completed: ${latest}`);
        return latest;
      }
    } else {
      console.log(`🔍 No new PDF files found in ${downloadDir}...`);
    }

    await new Promise((r) => setTimeout(r, 1000));
  }
  console.log("⏰ Download timeout reached");
  return null;
}

async function extractAndDownloadFIRs(fromDate, toDate, districtCode, jobId) {
  console.log(`🚀 Starting FIR extraction for job ${jobId}: ${fromDate} to ${toDate}, district code: ${districtCode}`);
  const startTime = Date.now();
  
  // ✅ Initialize all counters at function start to avoid scope issues
  let totalDownloaded = 0;
  
  try {
    updateJobProgress(jobId, "🔧 Setting up isolated download directory...", { totalDownloaded });
    const jobDownloadPath = ensureJobDownloadDir(jobId);

    updateJobProgress(jobId, "🌐 Launching browser (this may take a moment)...", { totalDownloaded });
    console.log(`🌐 Launching Puppeteer browser for job ${jobId}...`);
    const browser = await puppeteer.launch({
      headless: "new",
      defaultViewport: null,
      args: ["--start-maximized"]
    });

    try {
      updateJobProgress(jobId, "📖 Opening new browser tab...", { totalDownloaded });
      console.log(`📖 Creating new page for job ${jobId}...`);
      const page = await browser.newPage();

      updateJobProgress(jobId, "⚙️ Configuring download settings...", { totalDownloaded });
      console.log(`⚙️ Configuring download behavior for job ${jobId}...`);
      const client = await page.target().createCDPSession();
      const absPath = path.resolve(jobDownloadPath);
      console.log(`📂 Job ${jobId} absolute download path: ${absPath}`);
      
      let downloadBehaviorSet = false;
      try {
        await client.send("Browser.setDownloadBehavior", {
          behavior: "allow",
          downloadPath: absPath
        });
        downloadBehaviorSet = true;
        console.log(`✅ Job ${jobId}: Browser.setDownloadBehavior configured successfully`);
      } catch (e) {
        console.log(`⚠️ Job ${jobId}: Browser.setDownloadBehavior failed, trying Page.setDownloadBehavior...`);
      }
      
      if (!downloadBehaviorSet) {
        try {
          await client.send("Page.setDownloadBehavior", {
            behavior: "allow",
            downloadPath: absPath
          });
          console.log(`✅ Job ${jobId}: Page.setDownloadBehavior configured successfully`);
        } catch (e) {
          console.log(`⚠️ Job ${jobId}: Page.setDownloadBehavior also failed, relying on default downloads`);
        }
      }

      const url = "https://citizen.mahapolice.gov.in/Citizen/MH/PublishedFIRs.aspx";
      updateJobProgress(jobId, "🔗 Connecting to Maharashtra Police website...", { totalDownloaded });
      console.log(`🔗 Job ${jobId}: Navigating to: ${url}`);
      await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });
      
      updateJobProgress(jobId, "🔄 Loading website content...", { totalDownloaded });
      console.log(`🔄 Job ${jobId}: Reloading page...`);
      await page.reload({ waitUntil: "networkidle2" });

      updateJobProgress(jobId, "📏 Setting up search parameters (50 results per page)...", { totalDownloaded });
      console.log(`📏 Job ${jobId}: Setting page size to 50...`);
      await page.waitForSelector("#ContentPlaceHolder1_ucRecordView_ddlPageSize", { visible: true });
      await page.select("#ContentPlaceHolder1_ucRecordView_ddlPageSize", "50");
      console.log(`✅ Job ${jobId}: Page size set to 50`);

      updateJobProgress(jobId, `📅 Setting date range: ${fromDate} to ${toDate}...`, { totalDownloaded });
      console.log(`📅 Job ${jobId}: Setting from date: ${fromDate}`);
      await page.waitForSelector("#ContentPlaceHolder1_txtDateOfRegistrationFrom", { visible: true });
      await page.evaluate(
        (selector, date) => {
          const input = document.querySelector(selector);
          input.value = date;
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.dispatchEvent(new Event("change", { bubbles: true }));
        },
        "#ContentPlaceHolder1_txtDateOfRegistrationFrom",
        fromDate
      );

      console.log(`📅 Job ${jobId}: Setting to date: ${toDate}`);
      await page.evaluate(
        (selector, date) => {
          const input = document.querySelector(selector);
          input.value = date;
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.dispatchEvent(new Event("change", { bubbles: true }));
        },
        "#ContentPlaceHolder1_txtDateOfRegistrationTo",
        toDate
      );

      console.log(`🏛️ Job ${jobId}: Setting district: ${districtCode}`);
      await page.waitForSelector("#ContentPlaceHolder1_ddlDistrict", { visible: true });
      await page.select("#ContentPlaceHolder1_ddlDistrict", districtCode);
      console.log(`✅ Job ${jobId}: District selected`);

      updateJobProgress(jobId, "🔍 Executing search query...", { totalDownloaded });
      console.log(`🔍 Job ${jobId}: Clicking search button...`);
      await page.waitForSelector("#ContentPlaceHolder1_btnSearch", { visible: true });
      await Promise.all([
        page.click("#ContentPlaceHolder1_btnSearch"),
        page.waitForSelector("#ContentPlaceHolder1_gdvDeadBody", {
          visible: true,
          timeout: 60000
        })
      ]);
      console.log(`✅ Job ${jobId}: Search completed, results loaded`);

      const targetSections = [
        "प्राण्‍यांचा छळ प्रतिबंधक अधिनियम, १९६०",
        "महाराष्‍ट्र प्राणी संरक्षण (सुधारणा)अधिनियम,१९९५",
        "महाराष्ट्र पशु संरक्षण अधिनियम, १९७६",
        "पशु संरक्षण अधिनियम, १९५१"
      ];

      updateJobProgress(jobId, "🎯 Scanning for animal protection law violations...", { totalDownloaded });
      console.log(`🎯 Job ${jobId}: Target sections: ${targetSections.join(", ")}`);

      let pageIndex = 1;
      let isLastPage = false;
      const seenFirstRowHashes = new Set();

      while (!isLastPage) {
        const elapsedMinutes = (Date.now() - startTime) / 60000;
        const processingSpeed = totalDownloaded > 0 ? `${Math.round(totalDownloaded / elapsedMinutes)} files/min` : 'Calculating...';
        
        updateJobProgress(jobId, `📄 Processing page ${pageIndex}... (Scanning FIR records)`, { 
          currentPage: pageIndex, 
          totalDownloaded,
          processingSpeed
        });
        console.log(`📄 Job ${jobId}: Processing page ${pageIndex}...`);
        
        const firData = await page.evaluate(() => {
          const rows = Array.from(
            document.querySelectorAll("#ContentPlaceHolder1_gdvDeadBody tr")
          );
          return rows
            .map((row) => {
              const cells = Array.from(row.querySelectorAll("td"));
              return {
                data: cells.map((cell) => cell.innerText.trim()),
                downloadSelector:
                  cells[cells.length - 1]
                    ?.querySelector("input")
                    ?.getAttribute("id") || null
              };
            })
            .filter((row) => row.data.length === 10);
        });

        console.log(`📊 Job ${jobId}: Found ${firData.length} FIR records on page ${pageIndex}`);

        if (firData.length === 0) {
          console.log(`❌ Job ${jobId}: No FIR data found, ending pagination`);
          isLastPage = true;
          break;
        }

        if (firData.length > 0) {
          console.log(`📝 Job ${jobId}: Sample FIR data (first record):`);
          firData[0].data.forEach((cell, idx) => {
            console.log(`  Column ${idx}: ${cell.substring(0, 100)}${cell.length > 100 ? '...' : ''}`);
          });
        }

        const firstRowKey = JSON.stringify(firData[0]);
        if (seenFirstRowHashes.has(firstRowKey)) {
          console.log(`🔄 Job ${jobId}: Detected repeated data, ending pagination`);
          isLastPage = true;
        } else {
          seenFirstRowHashes.add(firstRowKey);
        }

        let pageDownloads = 0;
        for (const [index, fir] of firData.entries()) {
          try {
            const currentElapsedMinutes = (Date.now() - startTime) / 60000;
            const currentProcessingSpeed = totalDownloaded > 0 ? `${Math.round(totalDownloaded / currentElapsedMinutes)} files/min` : 'Calculating...';
            const estimatedTimeRemaining = totalDownloaded > 0 ? 
              `~${Math.round((currentElapsedMinutes / totalDownloaded) * (50 - totalDownloaded))} min remaining` : 
              'Calculating...';

            updateJobProgress(jobId, `📋 Page ${pageIndex}: Analyzing FIR ${index + 1}/${firData.length}`, { 
              currentPage: pageIndex, 
              totalDownloaded,
              processingSpeed: currentProcessingSpeed,
              estimatedTimeRemaining
            });
            console.log(`🔍 Job ${jobId}: Checking FIR ${index + 1}/${firData.length} on page ${pageIndex}`);
            
            const sectionText1 = fir.data[8] || "";
            const sectionText2 = fir.data[1] || "";
            const allText = sectionText1 + " " + sectionText2;
            
            console.log(`📋 Job ${jobId}: Section text: ${allText.substring(0, 200)}${allText.length > 200 ? '...' : ''}`);
            
            const matches = targetSections.some((s) => allText.includes(s));
            if (!matches) {
              console.log(`⏭️ Job ${jobId}: No target section match found, skipping`);
              continue;
            }
            
            console.log(`✅ Job ${jobId}: Target section match found!`);
            
            if (!fir.downloadSelector) {
              console.log(`❌ Job ${jobId}: No download selector found, skipping`);
              continue;
            }

            updateJobProgress(jobId, `📥 Downloading FIR file ${totalDownloaded + 1}... Please wait`, { 
              currentPage: pageIndex, 
              totalDownloaded,
              processingSpeed: currentProcessingSpeed
            });
            console.log(`📥 Job ${jobId}: Attempting download for selector: ${fir.downloadSelector}`);
            const filesBefore = new Set(fs.readdirSync(jobDownloadPath));
            console.log(`📁 Job ${jobId}: Files before download: ${filesBefore.size}`);
            
            await page.click(`#${fir.downloadSelector}`);
            console.log(`🖱️ Job ${jobId}: Download button clicked`);

            const downloadedFile = await waitForDownloadedPdf(
              jobDownloadPath,
              filesBefore,
              120000
            );

            if (downloadedFile) {
              console.log(`✅ Job ${jobId}: File downloaded: ${downloadedFile}`);
              
              const firNumberRaw = fir.data[7].split("/");
              const field2 = safe(fir.data[2] || "field2");
              const field3 = safe(fir.data[3] || "field3");
              const field4 = safe(fir.data[4] || "field4");
              const field6 = safe(fir.data[6] || "field6");
              
              const newFileName = `${field2}_${field3}_${field4}_${(firNumberRaw)}_${field6}.pdf`;
              console.log(`📝 Job ${jobId}: Renaming to: ${newFileName}`);

              const oldFilePath = path.join(jobDownloadPath, downloadedFile);
              const newFilePath = path.join(jobDownloadPath, newFileName);

              let finalPath = newFilePath;
              let i = 1;
              while (fs.existsSync(finalPath)) {
                const ext = path.extname(newFileName);
                const base = path.basename(newFileName, ext);
                finalPath = path.join(jobDownloadPath, `${base}(${i})${ext}`);
                i++;
              }
              
              fs.renameSync(oldFilePath, finalPath);
              console.log(`✅ Job ${jobId}: File renamed to: ${path.basename(finalPath)}`);
              
              pageDownloads++;
              totalDownloaded++; // ✅ Safe increment now that variable is properly scoped
              
              const updatedElapsedMinutes = (Date.now() - startTime) / 60000;
              const updatedProcessingSpeed = `${Math.round(totalDownloaded / updatedElapsedMinutes)} files/min`;
              
              updateJobProgress(jobId, `✅ Downloaded ${totalDownloaded} files successfully`, { 
                currentPage: pageIndex, 
                totalDownloaded,
                processingSpeed: updatedProcessingSpeed
              });
            } else {
              console.log(`❌ Job ${jobId}: Download failed or timed out`);
            }

            console.log(`⏳ Job ${jobId}: Waiting 1 second before next download...`);
            await new Promise((r) => setTimeout(r, 1000));
          } catch (err) {
            console.error(`❌ Job ${jobId}: Error processing FIR ${index + 1}: ${err.message}`);
          }
        }

        console.log(`📊 Job ${jobId}: Page ${pageIndex} summary: ${pageDownloads} downloads completed`);

        pageIndex++;
        updateJobProgress(jobId, `🔄 Moving to page ${pageIndex}... (${totalDownloaded} files collected so far)`, { 
          currentPage: pageIndex - 1, 
          totalDownloaded 
        });
        console.log(`🔄 Job ${jobId}: Attempting to navigate to page ${pageIndex}...`);
        
        const pageClicked = await page.evaluate((nextIndex) => {
          const links = Array.from(document.querySelectorAll(".gridPager a"));
          console.log(`Found ${links.length} pagination links`);
          
          let target = links.find((l) => l.innerText.trim() === String(nextIndex));
          if (!target) {
            console.log(`Page ${nextIndex} link not found, looking for dots...`);
            const dots = [...links].reverse().find((l) => l.innerText.trim() === "...");
            if (dots) {
              console.log(`Clicking dots to expand pagination...`);
              dots.click();
              return "dots";
            }
            console.log(`No more pages available`);
            return false;
          }
          console.log(`Clicking page ${nextIndex} link`);
          target.click();
          return true;
        }, pageIndex);

        if (!pageClicked) {
          console.log(`📄 Job ${jobId}: No more pages to process`);
          isLastPage = true;
          break;
        }

        if (pageClicked === "dots") {
          console.log(`⏳ Job ${jobId}: Waiting for pagination expansion...`);
        } else {
          console.log(`⏳ Job ${jobId}: Waiting for page ${pageIndex} to load...`);
        }

        await page.waitForSelector("#ContentPlaceHolder1_gdvDeadBody", {
          visible: true,
          timeout: 60000
        });
        console.log(`✅ Job ${jobId}: Page ${pageIndex} loaded successfully`);
      }

      console.log(`🎉 Job ${jobId}: Scraping completed! Total downloads: ${totalDownloaded}`);
      await browser.close();
      console.log(`🌐 Job ${jobId}: Browser closed`);
      
    } catch (err) {
      console.error(`❌ Job ${jobId}: Error during extraction: ${err.message}`);
      try {
        await browser.close();
        console.log(`🌐 Job ${jobId}: Browser closed after error`);
      } catch (_) {
        console.log(`⚠️ Job ${jobId}: Failed to close browser`);
      }
      throw err;
    }

    updateJobProgress(jobId, `🗜️ Creating ZIP file with ${totalDownloaded} documents...`, { totalDownloaded });
    console.log(`🗜️ Job ${jobId}: Creating ZIP file...`);
    const zipFilePath = path.join(__dirname, `downloaded_firs_${jobId}.zip`);
    
    await new Promise((resolve, reject) => {
      const output = fs.createWriteStream(zipFilePath);
      const archive = archiver("zip", { zlib: { level: 9 } });

      output.on("close", () => {
        console.log(`✅ Job ${jobId}: ZIP file created: ${archive.pointer()} total bytes`);
        resolve();
      });
      
      archive.on("error", (err) => {
        console.error(`❌ Job ${jobId}: ZIP creation error: ${err.message}`);
        reject(err);
      });

      archive.pipe(output);
      archive.directory(jobDownloadPath, false);
      archive.finalize();
    });

    console.log(`📦 Job ${jobId}: ZIP file ready at: ${zipFilePath}`);
    return zipFilePath;

  } catch (error) {
    console.error(`❌ Job ${jobId} failed: ${error.message}`);
    console.error(`Stack trace: ${error.stack}`);
    throw error;
  }
}

app.use(express.static(path.join(__dirname, "public")));

// Start FIR extraction job
app.post("/start-fir-job", async (req, res) => {
  console.log(`📥 Received request: POST /start-fir-job from ${req.ip}`);
  console.log(`📋 Body:`, req.body);
  
  const { fromDate, toDate, districtName } = req.body;

  if (!fromDate || !toDate || !districtName) {
    console.log("❌ Missing required parameters");
    return res.status(400).json({
      error: "Required parameters: fromDate, toDate, districtName"
    });
  }

  const dateFormat = "DD/MM/YYYY";
  if (
    !moment(fromDate, dateFormat, true).isValid() ||
    !moment(toDate, dateFormat, true).isValid()
  ) {
    console.log("❌ Invalid date format");
    return res.status(400).json({
      error: "Invalid date format. Use DD/MM/YYYY."
    });
  }

  const fromDateMoment = moment.tz(fromDate, dateFormat, "Asia/Kolkata");
  const toDateMoment = moment.tz(toDate, dateFormat, "Asia/Kolkata");

  if (fromDateMoment.isAfter(toDateMoment)) {
    console.log("❌ Invalid date range: fromDate is after toDate");
    return res.status(400).json({
      error: "'fromDate' should be before 'toDate'."
    });
  }

  if (toDateMoment.diff(fromDateMoment, "days") > 90) {
    console.log("❌ Date range exceeds 90 days");
    return res.status(400).json({
      error: "Date range should not exceed 90 days."
    });
  }

  const districtNameUpper = String(districtName).toUpperCase();
  const code = allowedDistricts[districtNameUpper];
  if (!code) {
    console.log(`❌ Invalid district: ${districtName}`);
    return res.status(400).json({
      error: "Invalid or unsupported district name."
    });
  }

  // Rate limiting per user IP
  const userJobs = Object.values(jobs).filter(j => 
    j.userIp === req.ip && 
    (j.status === 'started' || j.status === 'running')
  );
  if (userJobs.length >= 2) {
    console.log(`❌ Rate limit exceeded for IP: ${req.ip}`);
    return res.status(429).json({
      error: "Too many concurrent jobs. Please wait for existing jobs to complete."
    });
  }

  const jobId = `job_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  
  jobs[jobId] = {
    id: jobId,
    status: 'started',
    progress: '🔧 Initializing extraction job...',
    createdAt: new Date(),
    lastUpdated: new Date(),
    params: { fromDate, toDate, districtName, districtCode: code },
    totalDownloaded: 0,
    currentPage: 0,
    userIp: req.ip,
    userAgent: req.get('User-Agent') || 'Unknown',
    processingSpeed: 'Calculating...',
    estimatedTimeRemaining: 'Calculating...'
  };

  console.log(`✅ Job created: ${jobId} for IP: ${req.ip}`);
  console.log(`📊 Parameters: ${fromDate} to ${toDate}, District: ${districtName} (${code})`);

  // Start the job in background
  extractAndDownloadFIRs(fromDate, toDate, code, jobId)
    .then(zipPath => {
      jobs[jobId].status = 'completed';
      jobs[jobId].progress = `🎉 Completed! Downloaded ${jobs[jobId].totalDownloaded} animal protection law FIRs. Ready for download.`;
      jobs[jobId].zipPath = zipPath;
      jobs[jobId].completedAt = new Date();
      
      // Schedule cleanup after 30 minutes
      scheduleJobCleanup(jobId, 30);
      
      console.log(`✅ Job ${jobId} completed successfully`);
    })
    .catch(error => {
      jobs[jobId].status = 'failed';
      jobs[jobId].progress = `❌ Failed: ${error.message}`;
      jobs[jobId].error = error.message;
      jobs[jobId].failedAt = new Date();
      
      // Still schedule cleanup for failed jobs (shorter time)
      scheduleJobCleanup(jobId, 5);
      
      console.error(`❌ Job ${jobId} failed: ${error.message}`);
    });

  res.json({
    jobId,
    status: 'started',
    message: 'FIR extraction job started successfully. Use the jobId to check status.',
    estimatedTime: 'This process typically takes 5-30 minutes depending on the number of records.'
  });
  console.log(`📤 Response sent to client with jobId: ${jobId}`);
});

// Check job status
app.get("/job-status/:jobId", (req, res) => {
  console.log(`📥 Received request: GET /job-status/${req.params.jobId} from ${req.ip}`);
  
  const job = jobs[req.params.jobId];
  if (!job) {
    console.log(`❌ Job not found: ${req.params.jobId}`);
    return res.status(404).json({ error: 'Job not found' });
  }
  
  console.log(`📊 Job ${req.params.jobId} status: ${job.status} - ${job.progress}`);
  res.json({
    id: job.id,
    status: job.status,
    progress: job.progress,
    totalDownloaded: job.totalDownloaded || 0,
    currentPage: job.currentPage || 0,
    createdAt: job.createdAt,
    lastUpdated: job.lastUpdated,
    params: job.params,
    processingSpeed: job.processingSpeed || 'Calculating...',
    estimatedTimeRemaining: job.estimatedTimeRemaining || 'Calculating...'
  });
});

// Download ZIP file for completed job
app.get("/download-job-zip/:jobId", (req, res) => {
  console.log(`📥 Received request: GET /download-job-zip/${req.params.jobId} from ${req.ip}`);
  
  const job = jobs[req.params.jobId];
  if (!job) {
    console.log(`❌ Job not found: ${req.params.jobId}`);
    return res.status(404).send("Job not found.");
  }
  
  if (job.status !== 'completed') {
    console.log(`❌ Job not completed: ${req.params.jobId}`);
    return res.status(400).send("Job not completed yet.");
  }
  
  if (!job.zipPath || !fs.existsSync(job.zipPath)) {
    console.log(`❌ ZIP file not found: ${job.zipPath}`);
    return res.status(404).send("ZIP file not found.");
  }
  
  console.log(`📦 Sending ZIP file: ${job.zipPath}`);
  
  // Send file and mark it for deletion (files will be auto-deleted after 30 minutes from completion)
  res.download(job.zipPath, `animal_protection_firs_${job.params.districtName.replace(/ /g, '_')}_${job.params.fromDate.replace(/\//g, '-')}_to_${job.params.toDate.replace(/\//g, '-')}.zip`, (err) => {
    if (err) {
      console.error(`❌ Error sending ZIP file: ${err.message}`);
      res.status(500).send("Error downloading zip file.");
    } else {
      console.log(`✅ ZIP file sent successfully for job ${req.params.jobId}`);
      
      // Update job to show it's been downloaded
      if (jobs[req.params.jobId]) {
        jobs[req.params.jobId].lastDownloaded = new Date();
        jobs[req.params.jobId].downloadCount = (jobs[req.params.jobId].downloadCount || 0) + 1;
      }
    }
  });
});

// Get all jobs (admin/debug)
app.get("/jobs", (req, res) => {
  const jobSummaries = Object.values(jobs).map(job => ({
    id: job.id,
    status: job.status,
    progress: job.progress,
    totalDownloaded: job.totalDownloaded || 0,
    createdAt: job.createdAt,
    userIp: job.userIp,
    params: job.params,
    processingSpeed: job.processingSpeed || 'N/A'
  }));
  res.json(jobSummaries);
});

// Enhanced cleanup function
function cleanupOldJobs() {
  const now = new Date();
  const maxAge = 2 * 60 * 60 * 1000; // 2 hours (backup cleanup)
  let cleanedCount = 0;
  
  Object.keys(jobs).forEach(jobId => {
    const job = jobs[jobId];
    if (now - job.createdAt > maxAge) {
      const jobDownloadPath = getJobDownloadPath(jobId);
      if (fs.existsSync(jobDownloadPath)) {
        fs.rmSync(jobDownloadPath, { recursive: true, force: true });
        console.log(`🗑️ Backup cleanup - deleted job directory: ${jobDownloadPath}`);
      }
      
      if (job.zipPath && fs.existsSync(job.zipPath)) {
        fs.unlinkSync(job.zipPath);
        console.log(`🗑️ Backup cleanup - deleted ZIP file: ${job.zipPath}`);
      }
      
      delete jobs[jobId];
      cleanedCount++;
      console.log(`🗑️ Backup cleanup - removed old job: ${jobId}`);
    }
  });
  
  if (cleanedCount > 0) {
    console.log(`🧹 Backup cleanup completed: ${cleanedCount} old jobs removed`);
  }
}

// Run backup cleanup every 2 hours
setInterval(cleanupOldJobs, 2 * 60 * 60 * 1000);

// Create base downloads directory
const baseDownloadsPath = path.resolve("./downloads");
if (!fs.existsSync(baseDownloadsPath)) {
  fs.mkdirSync(baseDownloadsPath, { recursive: true });
  console.log(`📁 Created base downloads directory: ${baseDownloadsPath}`);
}

app.listen(port, host, () => {
  console.log(`🚀 Server listening at http://localhost:${port}`);
  console.log(`📁 Base downloads path: ${baseDownloadsPath}`);
  console.log(`🎯 Target: Animal protection law FIRs`);
  console.log(`📋 Available districts: ${Object.keys(allowedDistricts).length}`);
  console.log(`👥 Multi-user support: ENABLED`);
  console.log(`🗑️ Auto-cleanup: 30 minutes after completion`);
  console.log(`⚡ Rate limit: 2 concurrent jobs per IP`);
});
