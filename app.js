const puppeteer = require("puppeteer");
const fs = require("fs");
const path = require("path");
const moment = require("moment-timezone");
const express = require("express");
const archiver = require("archiver"); // For zipping files
const app = express();
const port = 3000;

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


const downloadPath = path.resolve("./downloads");

async function deleteAndCreateDownloadDir() {
    if (fs.existsSync(downloadPath)) {
        fs.rmSync(downloadPath, { recursive: true, force: true });
    }
    fs.mkdirSync(downloadPath);
}

async function extractAndDownloadFIRs(fromDate, toDate, districtCode, res) {
    await deleteAndCreateDownloadDir();

    const browser = await puppeteer.launch({
        headless: "new",
        defaultViewport: null,
        args: ['--start-maximized']
    });

    const page = await browser.newPage();
    const client = await page.target().createCDPSession();
    await client.send('Page.setDownloadBehavior', {
        behavior: 'allow',
        downloadPath: downloadPath
    });

    const url = "https://citizen.mahapolice.gov.in/Citizen/MH/PublishedFIRs.aspx";
    console.log("🔍 Opening FIR website...");
    await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });
    await page.reload({ waitUntil: "networkidle2" });
    await page.waitForSelector("#ContentPlaceHolder1_ucRecordView_ddlPageSize", { visible: true });
    await page.select("#ContentPlaceHolder1_ucRecordView_ddlPageSize", "50");


    await page.waitForSelector("#ContentPlaceHolder1_txtDateOfRegistrationFrom", { visible: true });
    await page.evaluate((selector, date) => {
        const input = document.querySelector(selector);
        input.value = date;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
    }, "#ContentPlaceHolder1_txtDateOfRegistrationFrom", fromDate);

    await page.evaluate((selector, date) => {
        const input = document.querySelector(selector);
        input.value = date;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
    }, "#ContentPlaceHolder1_txtDateOfRegistrationTo", toDate);

    await page.waitForSelector("#ContentPlaceHolder1_ddlDistrict", { visible: true });
    await page.select("#ContentPlaceHolder1_ddlDistrict", districtCode);

    await page.waitForSelector("#ContentPlaceHolder1_btnSearch", { visible: true });
    await Promise.all([
        page.waitForSelector("#ContentPlaceHolder1_gdvDeadBody", { visible: true, timeout: 30000 }),
        page.click("#ContentPlaceHolder1_btnSearch")
    ]);

    let pageIndex = 1;
    let isLastPage = false;
    const allFIRData = [];
    const targetSections = [
        "प्राण्‍यांचा छळ प्रतिबंधक अधिनियम, १९६०",
        "महाराष्‍ट्र प्राणी संरक्षण (सुधारणा)अधिनियम,१९९५",
        "महाराष्ट्र पशु संरक्षण अधिनियम, १९७६",
        "पशु संरक्षण अधिनियम, १९५१"
    ];

    console.log("✅ Search completed. Extracting FIR data...");

    while (!isLastPage) {
        console.log(`🔄 Extracting data from page ${pageIndex}...`);
        const firData = await page.evaluate(() => {
            const rows = Array.from(document.querySelectorAll("#ContentPlaceHolder1_gdvDeadBody tr"));
            return rows.map(row => {
                const cells = Array.from(row.querySelectorAll("td"));
                return {
                    data: cells.map(cell => cell.innerText.trim()),
                    downloadSelector: cells[cells.length - 1]?.querySelector("input")?.getAttribute("id") || null
                };
            }).filter(row => row.data.length === 10);
        });

        console.log(`✅ Extracted ${firData.length} FIRs from page ${pageIndex}`);

        if (firData.length === 0 || (allFIRData.length > 0 && allFIRData.some(existingRow => JSON.stringify(existingRow) === JSON.stringify(firData[0])))) {
            isLastPage = true;
            break;
        }

        firData.forEach(fir => {
            allFIRData.push(fir);
        });

        console.log(`📥 Downloading FIRs from page ${pageIndex}...`);

        for (const fir of firData) {
            const sectionText = fir.data[8];
            if (targetSections.some(section => sectionText.includes(section))) {
                if (fir.downloadSelector) {
                    const filesBeforeDownload = new Set(fs.readdirSync(downloadPath));
                    await page.click(`#${fir.downloadSelector}`);

                    let downloadedFile = null;
                    const timeout = 30000;
                    const startTime = Date.now();

                    while (!downloadedFile) {
                        const currentFiles = fs.readdirSync(downloadPath);
                        const newFiles = currentFiles.filter(file => file.endsWith(".pdf") && !filesBeforeDownload.has(file));
                        if (newFiles.length > 0) {
                            downloadedFile = newFiles.sort((a, b) => fs.statSync(path.join(downloadPath, b)).mtimeMs - fs.statSync(path.join(downloadPath, a)).mtimeMs)[0];
                            break;
                        }
                        if (Date.now() - startTime > timeout) break;
                        await new Promise(resolve => setTimeout(resolve, 1000));
                    }

                    if (downloadedFile) {
                        await new Promise(resolve => setTimeout(resolve, 5000));

                        const firNumber = fir.data[7].split("/")[0];
                        const newFileName = `${fir.data[2]}_${fir.data[3]}_${fir.data[4]}_${firNumber}_${fir.data[6]}.pdf`;

                        const oldFilePath = path.join(downloadPath, downloadedFile);
                        const newFilePath = path.join(downloadPath, newFileName);

                        fs.renameSync(oldFilePath, newFilePath);
                        console.log(`✅ Renamed file: ${downloadedFile} → ${newFileName}`);
                    }

                    await new Promise(resolve => setTimeout(resolve, 2000));
                }
            }
        }

        pageIndex++;
        const pageClicked = await page.evaluate((pageIndex) => {
            const paginationLinks = Array.from(document.querySelectorAll(".gridPager a"));
            let targetPage = paginationLinks.find(link => link.innerText.trim() === String(pageIndex));
            if (!targetPage) {
                const dotsElement = paginationLinks.reverse().find(link => link.innerText.trim() === "...");
                if (dotsElement) {
                    dotsElement.click();
                    return "dots";
                }
                return false;
            }
            targetPage.click();
            return true;
        }, pageIndex);

        console.log(`🔄 Navigating to page ${pageIndex}...`);

        if (pageClicked === "dots") {
            await page.waitForSelector("#ContentPlaceHolder1_gdvDeadBody", { visible: true, timeout: 30000 });
            continue;
        }
        if (!pageClicked) isLastPage = true;
        await page.waitForSelector("#ContentPlaceHolder1_gdvDeadBody", { visible: true, timeout: 30000 });
    }
    await browser.close();

    const zipFilePath = path.join(__dirname, 'downloaded_firs.zip');
    const output = fs.createWriteStream(zipFilePath);
    const archive = archiver('zip', { zlib: { level: 9 } });

    output.on('close', () => {
        console.log(`Zip file created: ${archive.pointer()} total bytes`);
        // Send a download link to the zip file
        res.send(`<a href="/download-zip">Download FIRs</a>`);
    });

    archive.on('error', (err) => {
        res.status(500).send("Error creating zip file.");
        throw err;
    });

    archive.pipe(output);
    archive.directory(downloadPath, false);
    archive.finalize();
}

console.log("🔄 Starting server...");

app.use(express.static(path.join(__dirname, 'public')));
app.use('/downloads', express.static(downloadPath)); // Serve the download folder

app.get("/download-firs", async (req, res) => {
    const { fromDate, toDate, districtName } = req.query;
    if (!fromDate || !toDate || !districtName) return res.status(400).send("❌ Required query params: fromDate, toDate, districtName");
    const dateFormat = "DD/MM/YYYY";
    if (!moment(fromDate, dateFormat, true).isValid() || !moment(toDate, dateFormat, true).isValid()) return res.status(400).send("❌ Invalid date format. Use DD/MM/YYYY.");
    const fromDateMoment = moment.tz(fromDate, dateFormat, "Asia/Kolkata");
    const toDateMoment = moment.tz(toDate, dateFormat, "Asia/Kolkata");
    if (toDateMoment.diff(fromDateMoment, "days") > 90) return res.status(400).send("❌ Date range should not exceed 90 days.");
    if (fromDateMoment.isAfter(toDateMoment)) return res.status(400).send("❌ 'fromDate' should be before 'toDate'.");
    const districtNameUpper = districtName.toUpperCase();
    if (!allowedDistricts[districtNameUpper]) return res.status(400).send("❌ Invalid or unsupported district name.");
    const code = allowedDistricts[districtNameUpper];
    try {
        console.log(`🔄 Downloading FIRs for district ${districtNameUpper} from ${fromDate} to ${toDate}...`);
        await extractAndDownloadFIRs(fromDate, toDate, code, res);
    } catch (error) {
        console.error("Error during FIR download:", error);
        res.status(500).send("An error occurred during FIR download.");
    }
});

app.get('/download-zip', (req, res) => {
    const zipFilePath = path.join(__dirname, 'downloaded_firs.zip');
    res.download(zipFilePath, 'downloaded_firs.zip', (err) => {
        if (err) {
            console.error('Error sending zip file:', err);
            res.status(500).send('Error downloading zip file.');
        }
    });
});

app.listen(port, () => {
    console.log(`Server listening at http://localhost:${port}`);
});
