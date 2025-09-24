import readline from 'readline';
import { chromium } from '@playwright/test';
import { GoogleGenAI } from '@google/genai';
import fs from 'fs';

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

const spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
let loading = false;
const GEMINI_API_KEY = ""; // IMPORTANT: Add your Gemini API key here
const genAI = new GoogleGenAI(GEMINI_API_KEY);
let cPage = null;
let pageElements = [];
let completed = false;
let spinner = null;
const modelResponses = [];

function showBrailleSpinner() {
    let i = 0;
    const interval = 80;
    loading = true;
    spinner = setInterval(() => {
        process.stdout.write(`\r${spinnerFrames[i++ % spinnerFrames.length]} Loading...`);
    }, interval);
}

function stopSpinner() {
    clearInterval(spinner);
    process.stdout.write('\r✓ Done!           \n');
}

(async () => {
    const browser = await chromium.launch({ headless: false, channel: "msedge" });
    const context = await browser.newContext();
    cPage = await context.newPage();
    await cPage.goto("https://job-boards.greenhouse.io/zenoti/jobs/6624060003");

    console.log('Page loaded successfully!');
    ask();
})();
async function overlayAndMapElements(page, pageElements) {
    // console.log(pageElements);

    await page.addStyleTag({
        content: `
        .__ai_overlay_box {
            position: absolute;
            background: transparent;
            border: 2px solid red;
            z-index: 999999;
            pointer-events: none;
            box-sizing: border-box;
        }
        .__ai_overlay_id {
            position: absolute;
            top: 2px;
            right: 2px;
            background-color: red;
            color: white;
            font-size: 12px;
            font-weight: bold;
            padding: 1px 4px;
            border-radius: 3px;
        }
    `});
    await page.evaluate(() => {
        document.querySelectorAll('.__ai_overlay_box').forEach(e => e.remove());
    });
    const elementMap = [];
    var selector = `input:not([type='hidden']), button, select, textarea, a, [role="button"], div[class*="select"]`;
    var locators = await page.locator(selector);
    for (var i = 0; i < await locators.count(); i++) {
        const locator = locators.nth(i);
        pageElements.push(locator);

        // Get bounding box and element info
        const box = await locator.boundingBox();
        const tagName = await locator.evaluate(el => el.tagName.toLowerCase());
        const ariaLabel = await locator.getAttribute('aria-label');
        const innerText = await locator.evaluate(el => el.innerText.trim());
        const name = await locator.evaluate(el => el.name || '');
        const idAttr = await locator.evaluate(el => el.id || '');

        // Draw overlay using the bounding box
        if (box) {
            await page.evaluate(
                ({ box, idx }) => {
                    const overlay = document.createElement('div');
                    overlay.className = '__ai_overlay_box';
                    overlay.style.top = `${box.y + window.scrollY}px`;
                    overlay.style.left = `${box.x + window.scrollX}px`;
                    overlay.style.width = `${box.width}px`;
                    overlay.style.height = `${box.height}px`;

                    const idLabel = document.createElement('div');
                    idLabel.className = '__ai_overlay_id';
                    idLabel.textContent = `#${idx}`;
                    overlay.appendChild(idLabel);

                    document.body.appendChild(overlay);
                },
                { box, idx: i }
            );
        }

        elementMap.push({
            id: `#${i}`,
            label: ariaLabel || innerText || name || idAttr || "",
            type: tagName,
        });
    };

    await page.screenshot({ path: "tagged_screenshot.png", fullPage: false });
    fs.writeFileSync("element_map.json", JSON.stringify(elementMap, null, 2));

    return elementMap;
}
async function scrollOneView() {
    const scrollHeightBefore = await cPage.evaluate(() => window.scrollY);
    await cPage.evaluate(() => window.scrollBy(0, window.innerHeight - 120));
    await cPage.waitForTimeout(500);
    const scrollHeightAfter = await cPage.evaluate(() => window.scrollY);

    if (scrollHeightBefore === scrollHeightAfter) {
        console.log("Already at the bottom of the page.");
    } else {
        console.log("Scrolled down one viewport.");
    }
}

async function executeAction(action, id, text, elementMap) {
    const element = elementMap.find(e => e.id === id);
    if (!element) {
        console.error(`Element with ID ${id} not found.`);
        return;
    }
    console.log(element);

    // const locator = cPage.locator(`text=${element.label}`).first();
    // console.log(locator);
    const locator = pageElements[parseInt(id.replace('#', ''))];
    switch (action) {
        case "click":
            console.log(`Clicking on: ${element.label} (${id})`);
            await locator.click();
            break;
        case "fill":
            console.log(`Filling "${text}" into: ${element.label} (${id})`);
            await locator.fill(text);
            break;
        case "scroll":
            console.log("Scrolling...");
            await scrollOneView();
            break;
        case "clear_field":
            console.log(`Clearing field: ${element.label} (${id})`);
            await locator.fill('');
            break;
        case "completed":
            console.log("Job application completed.");
            completed = true;
            break;
        default:
            console.log(`Unknown action: ${action}`);
    }
}


async function askGemini(prompt, elementMap) {
    if (!GEMINI_API_KEY || !cPage) {
        console.error('GEMINI_API_KEY is not set or page is not loaded.');
        return;
    }
    const scrshotBuffer = await cPage.screenshot({ path: "screenshot.png" });
    const scrshotBase64 = scrshotBuffer.toString('base64');
    // const scrshotBuffer = fs.readFileSync("tagged_screenshot.png");
    // const scrshotBase64 = scrshotBuffer.toString('base64');
    const pdfBase64 = fs.readFileSync('resume_vijay.pdf', 'base64');

    const model = genAI.chats.create({
        model: "gemini-2.5-flash",
        history: modelResponses && modelResponses.length ? modelResponses.map((item) => ({
            role: item?.role || "user",
            parts: [{ text: item?.text || "" }]
        }
        )) : []
    });

    const fullPrompt = `
        Observe the screenshot carefully. Your task is to apply for this job.
        Based on the screenshot and the list of interactive elements, determine the single next action to take.
        The available actions are: "click", "fill", "scroll", "clear_field", "completed".
        Return your response as a single JSON object with "action", "id", and optionally "text".
        - For "fill", provide the "text" to be entered.
        - For "scroll", you don't need an "id".
        - If the application is finished, use the "completed" action.
        - Do not perform any file uploads. I will handle that.
        My information:
        - Name: Vijay Reddy 
        - LinkedIn: https://www.linkedin.com/in/vijay-reddy-160mv/
        - GitHub: https://github.com/vijay1667/
        - Ethnicity: Asian
        - Gender: Male
        - Age: 18+

        Here is the list of interactive elements on the screen:
        ${JSON.stringify(elementMap, null, 2)}

        And here is my resume for additional context.
    `;

    const result = await model.sendMessage({
        message: [
            fullPrompt,
            {
                inlineData: {
                    data: scrshotBase64,
                    mimeType: 'image/png'
                }
            },
            {
                inlineData: {
                    data: pdfBase64,
                    mimeType: 'application/pdf'
                }
            }
        ]
    });

    const responseText = result.text;
    modelResponses.push({ role: "user", text: "Determine the next action by carefully following the above system instructions." });
    modelResponses.push({ role: "model", text: result.text });
    console.log("\n" + responseText);

    let cleanedJson = responseText.replace(/```json/g, '').replace(/```/g, '').trim();
    const actionData = JSON.parse(cleanedJson);

    await executeAction(actionData.action, actionData.id, actionData.text, elementMap);

    return actionData.action === "completed";
}

async function ask() {
    console.log('┌[ASK]────────────────────────────────────────────────────────');
    rl.question('Press Enter to continue, or type "exit" to close > ', async (name) => {
        if (name.toLowerCase() === 'exit') {
            console.log('Goodbye!');
            rl.close();
            process.exit(0);
        }

        showBrailleSpinner();
        try {
            while (!completed) {
                const elementMap = await overlayAndMapElements(cPage, pageElements);
                if (await askGemini("Continue", elementMap)) {
                    break;
                }
                console.log("Pausing for next step. Press Enter in the console to continue.");
                await new Promise(resolve => rl.once('line', resolve));
            }
        } catch (error) {
            console.error('\nError during automation step:', error);
        } finally {
            stopSpinner();
            console.log('└─────────────────────────────────────────────────────────────');
            if (completed) {
                console.log("Application process finished.");
                rl.close();
                process.exit(0);
            } else {
                ask(); // Ask for the next step
            }
        }
    });
}

process.on('SIGINT', () => {
    console.log('\nGoodbye!');
    rl.close();
    process.exit(0);
});