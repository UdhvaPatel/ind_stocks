// English / Hindi for the simple pages (Home, navigation). Keys are the English text;
// "{name}" placeholders are filled from the second argument. A missing translation
// falls back to English, so a new English string never breaks the page.

const HI = {
  // navigation and shell
  "Home": "होम", "Make a plan": "योजना बनाएँ", "Accuracy": "सटीकता", "My journal": "मेरी डायरी", "More": "और",
  // hero
  "Plans for {date}": "{date} की योजनाएँ",
  "Know the plan": "बाज़ार खुलने से पहले",
  "before the market opens.": "योजना जानिए।",
  "Pick a company. See what we expect for the next market day, the exact prices of a simple practice plan, and how often our past predictions were right, in rupees you can understand.":
    "कोई कंपनी चुनिए। अगले कारोबारी दिन के लिए हमारा अनुमान, एक सरल अभ्यास योजना के सटीक भाव, और हमारे पिछले अनुमान कितनी बार सही रहे, सब कुछ रुपयों में, आसान भाषा में देखिए।",
  "Choose a stock": "शेयर चुनें", "See the next-day picture": "अगले दिन का अनुमान देखें", "Check our past record": "हमारा पिछला रिकॉर्ड देखें",
  "closing prices landed inside our range (aim 90%; the range is wide)": "समापन भाव हमारी सीमा के अंदर रहे (लक्ष्य 90%; सीमा चौड़ी है)",
  "up/down calls right from the opening price (a coin flip gets 50%)": "शुरुआती भाव से ऊपर/नीचे का अनुमान सही (सिक्का उछालने पर 50%)",
  "big Indian companies": "बड़ी भारतीय कंपनियाँ",
  // step 1
  "The 50 biggest companies on India's National Stock Exchange. Prices are the last official close; nothing here is live.":
    "भारत के नेशनल स्टॉक एक्सचेंज की 50 सबसे बड़ी कंपनियाँ। भाव पिछले आधिकारिक बंद भाव हैं; यहाँ कुछ भी लाइव नहीं है।",
  "Search by name, e.g. Tata, Reliance, Infosys": "नाम से खोजें, जैसे टाटा, रिलायंस, इन्फोसिस",
  "Popular:": "लोकप्रिय:", "Show all 50 companies": "सभी 50 कंपनियाँ दिखाएँ", "Show fewer": "कम दिखाएँ",
  "No stock matches that search.": "इस खोज से कोई शेयर नहीं मिला।",
  "Pick any company above to see how the tool would have handled it.": "ऊपर से कोई भी कंपनी चुनें और देखें कि यह टूल उसके बारे में क्या कहता है।",
  // stock header and amount
  "If I put in": "अगर मैं लगाऊँ", "Change stock": "शेयर बदलें", "on {date}": "{date} को",
  // verdicts
  "Wait": "रुकें", "Weak signal": "कमज़ोर संकेत", "Stronger signal (still unproven)": "मज़बूत संकेत (अभी साबित नहीं)",
  "No tested reason to act today.": "आज कुछ करने का कोई परखा हुआ कारण नहीं है।",
  "None of the tested plans has made money on this stock after trading costs. Doing nothing is a valid choice, and the usual answer here.":
    "जाँची गई कोई भी योजना ट्रेडिंग खर्च के बाद इस शेयर पर पैसा नहीं कमा पाई। कुछ न करना भी एक सही फ़ैसला है, और यहाँ अक्सर यही जवाब होता है।",
  "One plan has a slightly positive past record here, but it could easily be luck.": "यहाँ एक योजना का पिछला रिकॉर्ड थोड़ा सकारात्मक है, लेकिन यह किस्मत भी हो सकती है।",
  "One plan has a positive past record here that is unlikely to be luck alone. It can still lose money; nothing here is a promise.":
    "यहाँ एक योजना का पिछला रिकॉर्ड सकारात्मक है जो केवल किस्मत नहीं लगता। फिर भी नुकसान हो सकता है; यहाँ कोई वादा नहीं है।",
  // cards
  "Next market day": "अगला कारोबारी दिन", "Likely closing range": "संभावित समापन सीमा", "on 9 out of 10 similar days": "10 में से 9 मिलते-जुलते दिनों में",
  "Chance of a higher close": "ऊँचे बंद होने की संभावना", "a coin flip is 50%": "सिक्का उछालने पर 50%",
  "See the practice plan (for learning only)": "अभ्यास योजना देखें (केवल सीखने के लिए)",
  "Practice plan: {name}": "अभ्यास योजना: {name}",
  "It triggers on about {p} of days": "यह लगभग {p} दिनों में सक्रिय होती है",
  "Last time": "पिछली बार", "How often we were right": "हम कितनी बार सही रहे", "last {n} market days": "पिछले {n} कारोबारी दिन",
  "Price prediction": "भाव का अनुमान", "Up or down": "ऊपर या नीचे", "correct": "सही", "missed": "चूक गए",
  "closing price landed in our range": "समापन भाव हमारी सीमा में रहा", "Our aim is 9 out of 10.": "हमारा लक्ष्य 10 में से 9 है।",
  "up-or-down call was right": "ऊपर-नीचे का अनुमान सही रहा", "A coin flip gets about half.": "सिक्का उछालने पर लगभग आधा।",
  "Real prediction": "असली अनुमान", "Test replay": "परीक्षण दोहराव", "Not proven": "प्रमाणित नहीं",
  "Practise with pretend money": "नकली पैसे से अभ्यास करें", "In your paper-trading journal": "आपकी अभ्यास डायरी में",
  "Open journal": "डायरी खोलें", "Undo": "वापस लें", "Try again": "फिर से कोशिश करें",
  "See every day on a chart": "हर दिन चार्ट पर देखें",
  "Only {n} verified live day{s} so far. Too early to judge; treat these figures as a test replay.":
    "अब तक केवल {n} प्रमाणित लाइव दिन। निष्कर्ष के लिए बहुत जल्दी है; इन आँकड़ों को परीक्षण मानें।",
  // footer
  "Plan with your own money": "अपने पैसों से योजना बनाएँ", "See every prediction on a chart": "हर अनुमान चार्ट पर देखें",
  "Detailed view for experienced users": "अनुभवी लोगों के लिए विस्तृत दृश्य", "Pro view": "प्रो दृश्य", "Honest research": "ईमानदार शोध", "See the test": "परीक्षण देखें",
  "Educational only, not investment advice. Predictions can be wrong, and past results do not guarantee future ones. Every money figure is an estimate after typical trading charges.":
    "केवल शिक्षा के लिए, निवेश सलाह नहीं। अनुमान गलत हो सकते हैं, और पिछले नतीजे भविष्य की गारंटी नहीं हैं। हर रकम सामान्य ट्रेडिंग शुल्क के बाद का अनुमान है।",
};

let lang = "en";
try { lang = localStorage.getItem("dd-lang") === "hi" ? "hi" : "en"; } catch (e) { /* storage blocked */ }

export const getLang = () => lang;
export function setLang(next) {
  lang = next === "hi" ? "hi" : "en";
  try { localStorage.setItem("dd-lang", lang); } catch (e) { /* storage blocked */ }
  if (typeof document !== "undefined" && document.documentElement && document.documentElement.setAttribute) document.documentElement.setAttribute("lang", lang === "hi" ? "hi" : "en-IN");
  loadFont();
}
export function t(text, vars) {
  let out = lang === "hi" && HI[text] ? HI[text] : text;
  if (vars) for (const [k, v] of Object.entries(vars)) out = out.split(`{${k}}`).join(String(v));
  return out;
}
export const hasHindi = (text) => Object.prototype.hasOwnProperty.call(HI, text);

// Devanagari font, loaded only when Hindi is chosen.
let fontLoaded = false;
function loadFont() {
  if (lang !== "hi" || fontLoaded || typeof document === "undefined" || !document.head) return;
  fontLoaded = true;
  const link = document.createElement("link");
  link.setAttribute("rel", "stylesheet");
  link.setAttribute("href", "https://fonts.googleapis.com/css2?family=Noto+Sans+Devanagari:wght@400;600;800&display=swap");
  document.head.append(link);
}
