/**
 * My Next Prediction v3.0 — M3.5 · Multi-asset Symbol Universe
 * ------------------------------------------------------------
 * Curated registry of tradeable symbols across every major asset class
 * EXCEPT crypto.  Crypto is loaded dynamically at boot from Binance's
 * exchangeInfo endpoints (`cryptoUniverse.js`) so every spot pair +
 * USDT-M perpetual + coin-M perpetual is reachable in real-time WS.
 *
 * Each entry shape:
 *   {
 *     id,              // canonical ticker (e.g. "AAPL", "EURUSD=X", "GC=F")
 *     name,            // human-readable label
 *     type,            // "stock"|"etf"|"forex"|"commodity"|"index"
 *     exchange,        // adapter id: "stooq" | "yahoo"
 *     currency,        // quote currency (USD/EUR/GBP/JPY/…)
 *     region?,         // "US"|"UK"|"EU"|"DE"|"FR"|"JP"|"IN"|"AU"|"CA"|"BR"|"GLOBAL"
 *     yahooSym?,       // Yahoo ticker (when different from .id)
 *     stooqSym?,       // Stooq ticker (default: lowercase id + ".us" for US)
 *     desc?,           // short descriptor (sector / theme)
 *   }
 *
 * Mutation API (`registerSymbols` / `onUniverseChange`) lets the
 * dynamic-crypto loader push thousands of additional entries at boot.
 */

/* ═══════════════════════════ US Stocks (S&P + popular tickers) ═══════════════════════════ */
const US_STOCKS = [
  // Mega-cap tech
  ["AAPL","Apple","Tech"], ["MSFT","Microsoft","Tech"], ["GOOGL","Alphabet A","Tech"], ["GOOG","Alphabet C","Tech"],
  ["AMZN","Amazon","Consumer"], ["META","Meta","Tech"], ["NVDA","NVIDIA","Tech"], ["TSLA","Tesla","Auto"],
  ["BRK-B","Berkshire B","Financial"], ["AVGO","Broadcom","Tech"],
  // Tech mid + AI + semis
  ["AMD","AMD","Tech"], ["INTC","Intel","Tech"], ["CRM","Salesforce","Tech"],
  ["ADBE","Adobe","Tech"], ["ORCL","Oracle","Tech"], ["CSCO","Cisco","Tech"], ["IBM","IBM","Tech"],
  ["QCOM","Qualcomm","Tech"], ["TXN","Texas Instruments","Tech"], ["NOW","ServiceNow","Tech"],
  ["INTU","Intuit","Tech"], ["AMAT","Applied Materials","Tech"], ["MU","Micron","Tech"],
  ["LRCX","Lam Research","Tech"], ["KLAC","KLA","Tech"], ["MRVL","Marvell","Tech"],
  ["PANW","Palo Alto Networks","Tech"], ["FTNT","Fortinet","Tech"], ["CRWD","CrowdStrike","Tech"],
  ["SNOW","Snowflake","Tech"], ["NET","Cloudflare","Tech"], ["DDOG","Datadog","Tech"],
  ["PLTR","Palantir","Tech"], ["WDAY","Workday","Tech"], ["TEAM","Atlassian","Tech"],
  ["ZS","Zscaler","Tech"], ["ANET","Arista Networks","Tech"], ["ASML","ASML","Tech"],
  ["TSM","Taiwan Semi","Tech"],
  // Communication / Media / Internet
  ["NFLX","Netflix","Media"], ["DIS","Disney","Media"], ["CMCSA","Comcast","Media"],
  ["T","AT&T","Telecom"], ["VZ","Verizon","Telecom"], ["TMUS","T-Mobile","Telecom"],
  ["UBER","Uber","Tech"], ["LYFT","Lyft","Tech"], ["ABNB","Airbnb","Consumer"],
  ["BKNG","Booking","Consumer"], ["PYPL","PayPal","Financial"], ["SQ","Block","Financial"],
  // Consumer
  ["WMT","Walmart","Consumer"], ["HD","Home Depot","Consumer"], ["LOW","Lowe's","Consumer"],
  ["COST","Costco","Consumer"], ["TGT","Target","Consumer"], ["MCD","McDonald's","Consumer"],
  ["SBUX","Starbucks","Consumer"], ["NKE","Nike","Consumer"], ["KO","Coca-Cola","Consumer"],
  ["PEP","PepsiCo","Consumer"], ["PG","Procter & Gamble","Consumer"], ["KHC","Kraft Heinz","Consumer"],
  ["MDLZ","Mondelez","Consumer"], ["CL","Colgate-Palmolive","Consumer"], ["EL","Estée Lauder","Consumer"],
  // Financials
  ["JPM","JPMorgan","Financial"], ["BAC","Bank of America","Financial"], ["WFC","Wells Fargo","Financial"],
  ["C","Citigroup","Financial"], ["GS","Goldman Sachs","Financial"], ["MS","Morgan Stanley","Financial"],
  ["AXP","American Express","Financial"], ["V","Visa","Financial"], ["MA","Mastercard","Financial"],
  ["BLK","BlackRock","Financial"], ["SCHW","Charles Schwab","Financial"], ["BX","Blackstone","Financial"],
  ["KKR","KKR","Financial"], ["COF","Capital One","Financial"], ["USB","US Bancorp","Financial"],
  ["TFC","Truist","Financial"], ["PNC","PNC","Financial"], ["MET","MetLife","Financial"],
  ["AIG","AIG","Financial"], ["ALL","Allstate","Financial"], ["TRV","Travelers","Financial"],
  ["AON","Aon","Financial"], ["MMC","Marsh McLennan","Financial"], ["SPGI","S&P Global","Financial"],
  ["MCO","Moody's","Financial"], ["ICE","ICE","Financial"], ["CME","CME Group","Financial"],
  // Healthcare
  ["JNJ","Johnson & Johnson","Health"], ["UNH","UnitedHealth","Health"], ["PFE","Pfizer","Health"],
  ["ABBV","AbbVie","Health"], ["MRK","Merck","Health"], ["LLY","Eli Lilly","Health"],
  ["TMO","Thermo Fisher","Health"], ["DHR","Danaher","Health"], ["ABT","Abbott","Health"],
  ["BMY","Bristol-Myers","Health"], ["AMGN","Amgen","Health"], ["GILD","Gilead","Health"],
  ["CVS","CVS Health","Health"], ["CI","Cigna","Health"], ["ISRG","Intuitive Surgical","Health"],
  ["VRTX","Vertex","Health"], ["REGN","Regeneron","Health"], ["BIIB","Biogen","Health"],
  ["BSX","Boston Scientific","Health"], ["MDT","Medtronic","Health"], ["SYK","Stryker","Health"],
  ["EW","Edwards Lifesciences","Health"], ["ZTS","Zoetis","Health"], ["MRNA","Moderna","Health"],
  ["NVO","Novo Nordisk","Health"],
  // Energy
  ["XOM","ExxonMobil","Energy"], ["CVX","Chevron","Energy"], ["SLB","Schlumberger","Energy"],
  ["EOG","EOG Resources","Energy"], ["MPC","Marathon Petroleum","Energy"], ["PSX","Phillips 66","Energy"],
  ["VLO","Valero","Energy"], ["OXY","Occidental","Energy"], ["COP","ConocoPhillips","Energy"],
  ["HAL","Halliburton","Energy"], ["DVN","Devon Energy","Energy"],
  ["BKR","Baker Hughes","Energy"], ["KMI","Kinder Morgan","Energy"], ["WMB","Williams","Energy"],
  ["ENB","Enbridge","Energy"], ["TRP","TC Energy","Energy"],
  // Industrials
  ["BA","Boeing","Industrial"], ["CAT","Caterpillar","Industrial"], ["DE","Deere","Industrial"],
  ["GE","General Electric","Industrial"], ["HON","Honeywell","Industrial"], ["UPS","UPS","Industrial"],
  ["FDX","FedEx","Industrial"], ["LMT","Lockheed Martin","Industrial"], ["RTX","RTX","Industrial"],
  ["NOC","Northrop Grumman","Industrial"], ["GD","General Dynamics","Industrial"], ["MMM","3M","Industrial"],
  ["ETN","Eaton","Industrial"], ["EMR","Emerson","Industrial"], ["ITW","Illinois Tool Works","Industrial"],
  ["PH","Parker Hannifin","Industrial"], ["CSX","CSX","Industrial"], ["UNP","Union Pacific","Industrial"],
  ["NSC","Norfolk Southern","Industrial"], ["LUV","Southwest","Industrial"], ["DAL","Delta","Industrial"],
  ["UAL","United Airlines","Industrial"], ["AAL","American Airlines","Industrial"],
  // Materials / Real Estate / Utilities
  ["LIN","Linde","Materials"], ["APD","Air Products","Materials"], ["ECL","Ecolab","Materials"],
  ["SHW","Sherwin-Williams","Materials"], ["FCX","Freeport-McMoRan","Materials"], ["NEM","Newmont","Materials"],
  ["CTVA","Corteva","Materials"], ["VMC","Vulcan Materials","Materials"], ["MLM","Martin Marietta","Materials"],
  ["AMT","American Tower","REIT"], ["PLD","Prologis","REIT"], ["CCI","Crown Castle","REIT"],
  ["EQIX","Equinix","REIT"], ["PSA","Public Storage","REIT"], ["O","Realty Income","REIT"],
  ["SPG","Simon Property","REIT"], ["DLR","Digital Realty","REIT"],
  ["NEE","NextEra Energy","Utility"], ["DUK","Duke Energy","Utility"], ["SO","Southern Co","Utility"],
  ["D","Dominion","Utility"], ["AEP","American Electric Power","Utility"], ["EXC","Exelon","Utility"],
  // Popular non-S&P tickers
  ["RIVN","Rivian","Auto"], ["LCID","Lucid","Auto"], ["NIO","NIO","Auto"], ["XPEV","XPeng","Auto"],
  ["LI","Li Auto","Auto"], ["F","Ford","Auto"], ["GM","General Motors","Auto"],
  ["BABA","Alibaba","Tech"], ["JD","JD.com","Tech"], ["PDD","PDD Holdings","Tech"], ["BIDU","Baidu","Tech"],
  ["NTES","NetEase","Tech"], ["EDU","New Oriental","Education"],
  ["COIN","Coinbase","Financial"], ["MSTR","MicroStrategy","Tech"], ["MARA","Marathon Digital","Crypto"],
  ["RIOT","Riot Platforms","Crypto"], ["HUT","Hut 8","Crypto"], ["CLSK","CleanSpark","Crypto"],
  ["GME","GameStop","Consumer"], ["AMC","AMC","Media"],
  ["HOOD","Robinhood","Financial"], ["SOFI","SoFi","Financial"], ["UPST","Upstart","Financial"],
  ["AFRM","Affirm","Financial"], ["LMND","Lemonade","Financial"], ["ROKU","Roku","Media"],
  ["SPOT","Spotify","Media"], ["WBD","Warner Bros Discovery","Media"],
  ["PARA","Paramount","Media"], ["FUBO","FuboTV","Media"], ["DKNG","DraftKings","Consumer"],
  ["PENN","Penn","Consumer"], ["MGM","MGM","Consumer"], ["WYNN","Wynn","Consumer"],
  ["LVS","Las Vegas Sands","Consumer"], ["CCL","Carnival","Consumer"], ["RCL","Royal Caribbean","Consumer"],
  ["NCLH","Norwegian Cruise","Consumer"], ["MAR","Marriott","Consumer"], ["HLT","Hilton","Consumer"],
  ["LULU","Lululemon","Consumer"], ["TJX","TJX","Consumer"],
  ["ULTA","Ulta Beauty","Consumer"], ["BBY","Best Buy","Consumer"], ["DG","Dollar General","Consumer"],
  ["DLTR","Dollar Tree","Consumer"], ["GPS","Gap","Consumer"], ["M","Macy's","Consumer"],
  ["KSS","Kohl's","Consumer"], ["JWN","Nordstrom","Consumer"], ["FIVE","Five Below","Consumer"],
  ["W","Wayfair","Consumer"], ["EBAY","eBay","Tech"], ["ETSY","Etsy","Tech"], ["SHOP","Shopify","Tech"],
  ["TWLO","Twilio","Tech"], ["DOCU","DocuSign","Tech"], ["ZM","Zoom","Tech"], ["U","Unity","Tech"],
  ["RBLX","Roblox","Tech"], ["PINS","Pinterest","Tech"], ["SNAP","Snap","Tech"],
  ["BB","BlackBerry","Tech"], ["NOK","Nokia","Tech"], ["ERIC","Ericsson","Tech"],
  ["FSLR","First Solar","Energy"], ["ENPH","Enphase","Energy"], ["SEDG","SolarEdge","Energy"],
  ["RUN","Sunrun","Energy"], ["PLUG","Plug Power","Energy"], ["BLDP","Ballard Power","Energy"],
  ["FCEL","FuelCell Energy","Energy"], ["BE","Bloom Energy","Energy"], ["NOV","NOV","Energy"],
].map(([id, name, desc]) => ({
  id, name, desc, type: "stock", exchange: "stooq", currency: "USD", region: "US",
  yahooSym: id, stooqSym: id.toLowerCase().replace(/\./g, "-") + ".us",
}));

/* ═══════════════════════════ International Stocks (Yahoo) ═══════════════════════════ */
const INTL_STOCKS = [
  // UK
  ["HSBA.L","HSBC","UK","GBP"], ["BP.L","BP","UK","GBP"], ["SHEL.L","Shell","UK","GBP"],
  ["AZN.L","AstraZeneca","UK","GBP"], ["GSK.L","GSK","UK","GBP"], ["RIO.L","Rio Tinto","UK","GBP"],
  ["GLEN.L","Glencore","UK","GBP"], ["VOD.L","Vodafone","UK","GBP"], ["ULVR.L","Unilever","UK","GBP"],
  ["DGE.L","Diageo","UK","GBP"], ["BARC.L","Barclays","UK","GBP"], ["LLOY.L","Lloyds","UK","GBP"],
  ["NWG.L","NatWest","UK","GBP"], ["TSCO.L","Tesco","UK","GBP"], ["BATS.L","British American Tobacco","UK","GBP"],
  ["IMB.L","Imperial Brands","UK","GBP"], ["PRU.L","Prudential","UK","GBP"], ["NG.L","National Grid","UK","GBP"],
  ["BA.L","BAE Systems","UK","GBP"], ["RR.L","Rolls-Royce","UK","GBP"],
  // Germany / France / Netherlands / Switzerland
  ["SAP.DE","SAP","DE","EUR"], ["SIE.DE","Siemens","DE","EUR"], ["ALV.DE","Allianz","DE","EUR"],
  ["MBG.DE","Mercedes-Benz","DE","EUR"], ["BMW.DE","BMW","DE","EUR"], ["VOW3.DE","Volkswagen","DE","EUR"],
  ["BAS.DE","BASF","DE","EUR"], ["BAYN.DE","Bayer","DE","EUR"], ["DBK.DE","Deutsche Bank","DE","EUR"],
  ["DTE.DE","Deutsche Telekom","DE","EUR"], ["ADS.DE","Adidas","DE","EUR"],
  ["MC.PA","LVMH","FR","EUR"], ["OR.PA","L'Oréal","FR","EUR"], ["TTE.PA","TotalEnergies","FR","EUR"],
  ["AIR.PA","Airbus","FR","EUR"], ["BNP.PA","BNP Paribas","FR","EUR"], ["SAN.PA","Sanofi","FR","EUR"],
  ["KER.PA","Kering","FR","EUR"], ["CS.PA","AXA","FR","EUR"], ["RMS.PA","Hermès","FR","EUR"],
  ["ASML.AS","ASML","NL","EUR"], ["ADYEN.AS","Adyen","NL","EUR"], ["INGA.AS","ING","NL","EUR"],
  ["NESN.SW","Nestlé","CH","CHF"], ["ROG.SW","Roche","CH","CHF"], ["NOVN.SW","Novartis","CH","CHF"],
  ["UBSG.SW","UBS","CH","CHF"], ["ZURN.SW","Zurich Insurance","CH","CHF"], ["ABBN.SW","ABB","CH","CHF"],
  // Japan
  ["7203.T","Toyota","JP","JPY"], ["6758.T","Sony","JP","JPY"], ["6861.T","Keyence","JP","JPY"],
  ["9984.T","SoftBank","JP","JPY"], ["8306.T","Mitsubishi UFJ","JP","JPY"], ["7974.T","Nintendo","JP","JPY"],
  ["6098.T","Recruit","JP","JPY"], ["9433.T","KDDI","JP","JPY"], ["8035.T","Tokyo Electron","JP","JPY"],
  ["6594.T","Nidec","JP","JPY"], ["8316.T","Sumitomo Mitsui","JP","JPY"], ["4063.T","Shin-Etsu","JP","JPY"],
  // India
  ["RELIANCE.NS","Reliance","IN","INR"], ["TCS.NS","TCS","IN","INR"], ["HDFCBANK.NS","HDFC Bank","IN","INR"],
  ["INFY.NS","Infosys","IN","INR"], ["ICICIBANK.NS","ICICI Bank","IN","INR"], ["HINDUNILVR.NS","HUL","IN","INR"],
  ["SBIN.NS","SBI","IN","INR"], ["BHARTIARTL.NS","Bharti Airtel","IN","INR"], ["ITC.NS","ITC","IN","INR"],
  ["LT.NS","Larsen & Toubro","IN","INR"], ["KOTAKBANK.NS","Kotak Mahindra","IN","INR"], ["AXISBANK.NS","Axis Bank","IN","INR"],
  ["MARUTI.NS","Maruti Suzuki","IN","INR"], ["WIPRO.NS","Wipro","IN","INR"], ["HCLTECH.NS","HCL Tech","IN","INR"],
  ["ASIANPAINT.NS","Asian Paints","IN","INR"], ["BAJFINANCE.NS","Bajaj Finance","IN","INR"], ["TATAMOTORS.NS","Tata Motors","IN","INR"],
  ["TATASTEEL.NS","Tata Steel","IN","INR"], ["ONGC.NS","ONGC","IN","INR"], ["NTPC.NS","NTPC","IN","INR"],
  ["TITAN.NS","Titan","IN","INR"], ["ADANIENT.NS","Adani Enterprises","IN","INR"], ["ADANIPORTS.NS","Adani Ports","IN","INR"],
  // Hong Kong
  ["0700.HK","Tencent","HK","HKD"], ["9988.HK","Alibaba HK","HK","HKD"], ["3690.HK","Meituan","HK","HKD"],
  ["1810.HK","Xiaomi","HK","HKD"], ["1299.HK","AIA","HK","HKD"], ["0939.HK","CCB","HK","HKD"],
  ["0388.HK","HKEX","HK","HKD"], ["1288.HK","ABC China","HK","HKD"], ["3988.HK","Bank of China","HK","HKD"],
  // Korea
  ["005930.KS","Samsung Electronics","KR","KRW"], ["000660.KS","SK Hynix","KR","KRW"],
  ["051910.KS","LG Chem","KR","KRW"], ["207940.KS","Samsung Biologics","KR","KRW"],
  // Australia
  ["BHP.AX","BHP","AU","AUD"], ["CBA.AX","Commonwealth Bank","AU","AUD"], ["WBC.AX","Westpac","AU","AUD"],
  ["NAB.AX","NAB","AU","AUD"], ["ANZ.AX","ANZ","AU","AUD"], ["CSL.AX","CSL","AU","AUD"],
  ["WES.AX","Wesfarmers","AU","AUD"], ["WOW.AX","Woolworths","AU","AUD"], ["TLS.AX","Telstra","AU","AUD"],
  ["FMG.AX","Fortescue","AU","AUD"], ["MQG.AX","Macquarie","AU","AUD"],
  // Canada
  ["RY.TO","Royal Bank of Canada","CA","CAD"], ["TD.TO","TD Bank","CA","CAD"], ["BNS.TO","Bank of Nova Scotia","CA","CAD"],
  ["BMO.TO","Bank of Montreal","CA","CAD"], ["CM.TO","CIBC","CA","CAD"], ["CNR.TO","CN Rail","CA","CAD"],
  ["CP.TO","Canadian Pacific","CA","CAD"], ["SHOP.TO","Shopify CA","CA","CAD"], ["ENB.TO","Enbridge CA","CA","CAD"],
  ["TRP.TO","TC Energy CA","CA","CAD"], ["SU.TO","Suncor","CA","CAD"], ["CNQ.TO","Canadian Natural","CA","CAD"],
  // Brazil
  ["PETR4.SA","Petrobras","BR","BRL"], ["VALE3.SA","Vale","BR","BRL"], ["ITUB4.SA","Itaú Unibanco","BR","BRL"],
  ["BBDC4.SA","Bradesco","BR","BRL"], ["ABEV3.SA","Ambev","BR","BRL"], ["WEGE3.SA","Weg","BR","BRL"],
  ["MGLU3.SA","Magazine Luiza","BR","BRL"],
].map(([id, name, region, currency]) => ({
  id, name, type: "stock", exchange: "yahoo", region, currency, yahooSym: id,
}));

/* ═══════════════════════════ ETFs ═══════════════════════════ */
const ETFS = [
  // Broad-market index
  ["SPY","SPDR S&P 500","Index"], ["VOO","Vanguard S&P 500","Index"], ["IVV","iShares S&P 500","Index"],
  ["QQQ","Invesco QQQ","Index"], ["DIA","SPDR Dow","Index"], ["IWM","iShares Russell 2000","Index"],
  ["VTI","Vanguard Total Stock","Index"], ["VEA","Vanguard FTSE Developed","International"],
  ["VWO","Vanguard EM","International"], ["IEFA","iShares Core EAFE","International"],
  ["IEMG","iShares Core EM","International"], ["EFA","iShares MSCI EAFE","International"],
  ["EEM","iShares MSCI EM","International"],
  // Sector
  ["XLK","Tech Select","Sector"], ["XLF","Financials Select","Sector"], ["XLE","Energy Select","Sector"],
  ["XLV","Health Care Select","Sector"], ["XLI","Industrials Select","Sector"], ["XLP","Cons. Staples","Sector"],
  ["XLY","Cons. Discretionary","Sector"], ["XLU","Utilities","Sector"], ["XLB","Materials","Sector"],
  ["XLRE","Real Estate","Sector"], ["XLC","Communications","Sector"],
  // Thematic
  ["ARKK","ARK Innovation","Thematic"], ["ARKQ","ARK Autonomous","Thematic"], ["ARKG","ARK Genomic","Thematic"],
  ["ARKW","ARK Internet","Thematic"], ["ARKF","ARK Fintech","Thematic"], ["ICLN","Clean Energy","Thematic"],
  ["TAN","Solar","Thematic"], ["LIT","Lithium & Battery","Thematic"], ["URA","Uranium","Thematic"],
  ["BOTZ","Robotics & AI","Thematic"], ["AIQ","AI & Big Data","Thematic"], ["SMH","Semiconductor","Thematic"],
  ["SOXX","iShares Semi","Thematic"], ["IBB","Biotech","Thematic"], ["XBI","SPDR Biotech","Thematic"],
  ["IYR","Real Estate ETF","Thematic"], ["KRE","Regional Banks","Thematic"], ["JETS","Airlines","Thematic"],
  // Bonds
  ["AGG","iShares Aggregate Bond","Bond"], ["BND","Vanguard Total Bond","Bond"], ["TLT","20+ Yr Treasury","Bond"],
  ["IEF","7-10 Yr Treasury","Bond"], ["SHY","1-3 Yr Treasury","Bond"], ["LQD","IG Corp","Bond"],
  ["HYG","High Yield","Bond"], ["JNK","High Yield","Bond"], ["EMB","EM Bond","Bond"],
  ["TIP","TIPS","Bond"], ["BIL","1-3 Mo T-Bill","Bond"],
  // Commodities
  ["GLD","Gold","Commodity"], ["IAU","iShares Gold","Commodity"], ["SLV","Silver","Commodity"],
  ["USO","US Oil","Commodity"], ["UNG","US Natural Gas","Commodity"], ["DBA","Agriculture","Commodity"],
  ["DBC","Commodities Index","Commodity"], ["CORN","Corn","Commodity"], ["WEAT","Wheat","Commodity"],
  ["UGA","Gasoline","Commodity"],
  // Crypto-related
  ["IBIT","iShares Bitcoin","Crypto"], ["FBTC","Fidelity Bitcoin","Crypto"], ["BITO","ProShares Bitcoin","Crypto"],
  ["GBTC","Grayscale Bitcoin","Crypto"], ["ETHE","Grayscale Ethereum","Crypto"],
  // Country / regional
  ["FXI","China Large-Cap","International"], ["MCHI","MSCI China","International"], ["INDA","MSCI India","International"],
  ["EWJ","Japan","International"], ["EWZ","Brazil","International"], ["EWG","Germany","International"],
  ["EWU","UK","International"], ["EWC","Canada","International"], ["EWA","Australia","International"],
  ["EWY","South Korea","International"], ["EWT","Taiwan","International"], ["EWS","Singapore","International"],
  ["EWH","Hong Kong","International"], ["EWP","Spain","International"], ["EWQ","France","International"],
  // Inverse / leveraged / Volatility / Dividends
  ["SQQQ","ProShares UltraPro Short QQQ","Inverse"], ["TQQQ","ProShares UltraPro QQQ","Leveraged"],
  ["SH","ProShares Short S&P","Inverse"], ["UPRO","ProShares UltraPro S&P","Leveraged"],
  ["VXX","iPath VIX","Volatility"], ["UVXY","2x VIX","Volatility"], ["SVXY","Short VIX","Volatility"],
  ["VYM","Vanguard High Dividend","Dividend"], ["SCHD","Schwab US Dividend","Dividend"],
  ["DVY","iShares Select Dividend","Dividend"], ["NOBL","ProShares Aristocrats","Dividend"],
].map(([id, name, desc]) => ({
  id, name, desc, type: "etf", exchange: "stooq", currency: "USD", region: "US",
  yahooSym: id, stooqSym: id.toLowerCase() + ".us",
}));

/* ═══════════════════════════ Forex (Yahoo `=X` symbols) ═══════════════════════════ */
const FOREX = [
  // Majors
  ["EURUSD=X","EUR/USD"], ["GBPUSD=X","GBP/USD"], ["USDJPY=X","USD/JPY"], ["USDCHF=X","USD/CHF"],
  ["AUDUSD=X","AUD/USD"], ["NZDUSD=X","NZD/USD"], ["USDCAD=X","USD/CAD"],
  // Crosses
  ["EURJPY=X","EUR/JPY"], ["EURGBP=X","EUR/GBP"], ["EURCHF=X","EUR/CHF"], ["EURAUD=X","EUR/AUD"],
  ["GBPJPY=X","GBP/JPY"], ["GBPCHF=X","GBP/CHF"], ["GBPAUD=X","GBP/AUD"], ["GBPCAD=X","GBP/CAD"],
  ["AUDJPY=X","AUD/JPY"], ["AUDNZD=X","AUD/NZD"], ["AUDCAD=X","AUD/CAD"], ["AUDCHF=X","AUD/CHF"],
  ["CADJPY=X","CAD/JPY"], ["CHFJPY=X","CHF/JPY"], ["NZDJPY=X","NZD/JPY"],
  // Emerging-market
  ["USDCNY=X","USD/CNY"], ["USDINR=X","USD/INR"], ["USDBRL=X","USD/BRL"], ["USDMXN=X","USD/MXN"],
  ["USDZAR=X","USD/ZAR"], ["USDHKD=X","USD/HKD"], ["USDSGD=X","USD/SGD"], ["USDKRW=X","USD/KRW"],
  ["USDTHB=X","USD/THB"], ["USDIDR=X","USD/IDR"], ["USDPHP=X","USD/PHP"], ["USDMYR=X","USD/MYR"],
  ["USDTRY=X","USD/TRY"], ["USDPLN=X","USD/PLN"], ["USDHUF=X","USD/HUF"], ["USDCZK=X","USD/CZK"],
  ["USDRUB=X","USD/RUB"], ["USDSEK=X","USD/SEK"], ["USDNOK=X","USD/NOK"], ["USDDKK=X","USD/DKK"],
].map(([id, name]) => ({ id, name, type: "forex", exchange: "yahoo", currency: "USD", yahooSym: id }));

/* ═══════════════════════════ Commodities (Yahoo `=F` futures) ═══════════════════════════ */
const COMMODITIES = [
  // Metals
  ["GC=F","Gold","Metals"], ["SI=F","Silver","Metals"], ["PL=F","Platinum","Metals"], ["PA=F","Palladium","Metals"],
  ["HG=F","Copper","Metals"],
  // Energy
  ["CL=F","Crude Oil","Energy"], ["BZ=F","Brent Crude","Energy"], ["NG=F","Natural Gas","Energy"],
  ["RB=F","Gasoline RBOB","Energy"], ["HO=F","Heating Oil","Energy"],
  // Agriculture
  ["ZC=F","Corn","Agriculture"], ["ZW=F","Wheat","Agriculture"], ["ZS=F","Soybeans","Agriculture"],
  ["ZL=F","Soybean Oil","Agriculture"], ["ZM=F","Soybean Meal","Agriculture"],
  ["KC=F","Coffee","Agriculture"], ["CC=F","Cocoa","Agriculture"], ["SB=F","Sugar","Agriculture"],
  ["CT=F","Cotton","Agriculture"], ["OJ=F","Orange Juice","Agriculture"],
  // Livestock
  ["LE=F","Live Cattle","Livestock"], ["GF=F","Feeder Cattle","Livestock"], ["HE=F","Lean Hogs","Livestock"],
  // Lumber
  ["LBS=F","Lumber","Materials"],
].map(([id, name, desc]) => ({
  id, name, desc, type: "commodity", exchange: "yahoo", currency: "USD", yahooSym: id,
}));

/* ═══════════════════════════ Indices (Yahoo `^` tickers) ═══════════════════════════ */
const INDICES = [
  // North America
  ["^GSPC","S&P 500","US","USD"], ["^DJI","Dow Jones","US","USD"], ["^IXIC","NASDAQ Composite","US","USD"],
  ["^NDX","NASDAQ 100","US","USD"], ["^RUT","Russell 2000","US","USD"], ["^VIX","CBOE VIX","US","USD"],
  ["^GSPTSE","S&P/TSX","CA","CAD"],
  // Europe
  ["^FTSE","FTSE 100","UK","GBP"], ["^GDAXI","DAX","DE","EUR"], ["^FCHI","CAC 40","FR","EUR"],
  ["^STOXX50E","Euro Stoxx 50","EU","EUR"], ["^IBEX","IBEX 35","ES","EUR"], ["^SSMI","SMI","CH","CHF"],
  ["^AEX","AEX","NL","EUR"], ["^OMXS30","OMX Stockholm","SE","SEK"], ["^FTMIB","FTSE MIB","IT","EUR"],
  // Asia-Pacific
  ["^N225","Nikkei 225","JP","JPY"], ["^HSI","Hang Seng","HK","HKD"], ["000001.SS","Shanghai Composite","CN","CNY"],
  ["399001.SZ","Shenzhen","CN","CNY"], ["^KS11","KOSPI","KR","KRW"], ["^TWII","TSEC Weighted","TW","TWD"],
  ["^STI","Straits Times","SG","SGD"], ["^JKSE","Jakarta Comp","ID","IDR"], ["^KLSE","KLSE","MY","MYR"],
  ["^AXJO","ASX 200","AU","AUD"], ["^NZ50","NZX 50","NZ","NZD"],
  ["^BSESN","BSE SENSEX","IN","INR"], ["^NSEI","NIFTY 50","IN","INR"],
  // Latin America / Africa
  ["^BVSP","Bovespa","BR","BRL"], ["^MXX","IPC Mexico","MX","MXN"], ["^MERV","Merval","AR","ARS"],
  // Specialty
  ["^MOVE","Move Index","US","USD"], ["^DJT","DJ Transportation","US","USD"],
  ["^DJU","DJ Utility","US","USD"], ["^OEX","S&P 100","US","USD"],
].map(([id, name, region, currency]) => ({ id, name, type: "index", exchange: "yahoo", region, currency, yahooSym: id }));

/* ═══════════════════════════ Public surface ═══════════════════════════ */

/** Curated seed (no crypto — that comes from cryptoUniverse.js at boot). */
export const SEED = Object.freeze([
  ...US_STOCKS,
  ...INTL_STOCKS,
  ...ETFS,
  ...FOREX,
  ...COMMODITIES,
  ...INDICES,
]);

/** Ordered asset-class keys (drives the tabs in the picker UI). */
export const TYPES = Object.freeze(["all", "crypto", "stock", "etf", "forex", "commodity", "index"]);

/* ─── Mutable in-memory registry ─── */
let _all  = SEED.slice();
let _byId = new Map(_all.map((e) => [e.id, e]));
const listeners = new Set();
function fire() { for (const fn of listeners) try { fn(); } catch {} }

/** Snapshot of the full universe.  Never mutate the array. */
export function listUniverse() { return _all; }

/** O(1) lookup by id. */
export function getSymbol(id) { return _byId.get(id) || null; }

/**
 * Merge entries into the registry.  Dedupes by id.  Existing fields are
 * preserved unless overridden by the new entry's value.  Fires
 * `onUniverseChange` listeners exactly once per call.
 *
 * @returns {{added:number, updated:number}}
 */
export function registerSymbols(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return { added: 0, updated: 0 };
  let added = 0, updated = 0;
  for (const e of entries) {
    if (!e || !e.id || !e.type) continue;
    const prev = _byId.get(e.id);
    if (prev) {
      const merged = { ...prev };
      for (const k of ["name","exchange","region","currency","yahooSym","stooqSym","desc","category","perp","base","quote"]) {
        if (e[k] != null) merged[k] = e[k];
      }
      _byId.set(e.id, merged);
      const idx = _all.indexOf(prev);
      if (idx >= 0) _all[idx] = merged;
      updated++;
    } else {
      _byId.set(e.id, e);
      _all.push(e);
      added++;
    }
  }
  if (added || updated) fire();
  return { added, updated };
}

/** Subscribe to universe changes.  Returns an off() function. */
export function onUniverseChange(fn) {
  if (typeof fn !== "function") return () => {};
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Reset to seed — tests only. */
export function _resetUniverseForTests() {
  _all  = SEED.slice();
  _byId = new Map(_all.map((e) => [e.id, e]));
  fire();
}

/**
 * Filter the universe by query + optional type.
 * Searches id/name/desc/region/currency, case-insensitive.
 */
export function searchUniverse(query, type = "all", limit = 200) {
  const q = (query || "").trim().toLowerCase();
  const out = [];
  for (const e of _all) {
    if (type !== "all" && e.type !== type) continue;
    if (q) {
      const hay = `${e.id} ${e.name || ""} ${e.desc || ""} ${e.region || ""} ${e.currency || ""}`.toLowerCase();
      if (!hay.includes(q)) continue;
    }
    out.push(e);
    if (out.length >= limit) break;
  }
  return out;
}

/** Counts per type — useful for tab badges. */
export function counts() {
  const byType = { all: _all.length };
  for (const e of _all) byType[e.type] = (byType[e.type] || 0) + 1;
  return byType;
}

/** Look up the right `exchange` adapter id for a symbol. */
export function exchangeFor(idOrEntry) {
  const e = typeof idOrEntry === "string" ? _byId.get(idOrEntry) : idOrEntry;
  return e ? e.exchange : null;
}

/* ── Backwards-compat aliases ── */
export const UNIVERSE = listUniverse();
export const BY_ID    = new Proxy({}, { get(_, key) { return _byId.get(key); } });
