/**
 * =============================================
 * MARKET MAKING SIMULATOR
 * Volatility-adaptive, inventory-aware strategy
 * =============================================
 */

'use strict';

// ===========================================
// 1. CONFIGURATION MODULE
// ===========================================

/**
 * Asset-specific configurations with default parameters
 * Each asset has different volatility characteristics
 */
const ASSET_CONFIGS = {
    BTC: {
        kVol: 0.2,          // Volatility multiplier (0.15 - 0.25 typical)
        kPos: 0.3,          // Position skew factor (0.2 - 0.4 typical)
        tickSize: 1,        // Price rounded to integers
        maxPosition: 0.5,   // Max position in asset units
        initPrice: 95000,   // Starting price for simulation
        coinId: 'bitcoin',  // CoinGecko API ID
        decimals: 0         // Price display decimals
    },
    ETH: {
        kVol: 0.25,
        kPos: 0.35,
        tickSize: 0.01,
        maxPosition: 5,
        initPrice: 3300,
        coinId: 'ethereum',
        decimals: 2
    },
    SOL: {
        kVol: 0.3,
        kPos: 0.5,
        tickSize: 0.001,
        maxPosition: 50,
        initPrice: 190,
        coinId: 'solana',
        decimals: 3
    },
    APT: {
        kVol: 0.5,
        kPos: 0.7,
        tickSize: 0.001,
        maxPosition: 100,
        initPrice: 9.5,
        coinId: 'aptos',
        decimals: 3
    }
};

/**
 * Volatility regime configurations
 * Affects price movement intensity in simulation mode
 */
const VOLATILITY_REGIMES = {
    low: { factor: 0.5, description: 'Calm market' },
    medium: { factor: 1.0, description: 'Normal conditions' },
    high: { factor: 2.0, description: 'Volatile market' }
};

/**
 * Trading constants
 */
const TRADING_CONFIG = {
    leverage: 10,               // 10x leverage
    orderSizeUSD: 50,          // Fixed $50 notional per order
    collapseThreshold: 100,    // Collapse when balance < $100
    defaultBalance: 1000,      // Starting balance
    tickIntervalMs: 1500,      // Simulation tick interval (1.5 seconds)
    priceUpdateIntervalMs: 5000, // Live price fetch interval (5 seconds)
    candleDurationMs: 5000,    // 5-second candles for ATR
    atrLength: 20              // Default ATR period
};


// ===========================================
// 2. SEEDABLE RNG MODULE
// ===========================================

/**
 * Mulberry32 - Fast, seedable PRNG
 * Provides deterministic random numbers for reproducible simulations
 */
class SeededRNG {
    constructor(seed = 12345) {
        this.seed = seed;
        this.state = seed;
    }

    /**
     * Reset RNG state to initial seed
     */
    reset() {
        this.state = this.seed;
    }

    /**
     * Set new seed and reset state
     */
    setSeed(seed) {
        this.seed = seed;
        this.state = seed;
    }

    /**
     * Generate random number between 0 and 1
     * Uses Mulberry32 algorithm for fast, quality randomness
     */
    random() {
        let t = this.state += 0x6D2B79F5;
        t = Math.imul(t ^ t >>> 15, t | 1);
        t ^= t + Math.imul(t ^ t >>> 7, t | 61);
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
    }

    /**
     * Generate random number in range [min, max]
     */
    randomRange(min, max) {
        return min + this.random() * (max - min);
    }

    /**
     * Generate normally distributed random number (Box-Muller)
     * Used for price movements
     */
    randomNormal(mean = 0, stdDev = 1) {
        const u1 = this.random();
        const u2 = this.random();
        const z0 = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
        return mean + z0 * stdDev;
    }
}


// ===========================================
// 3. ATR CALCULATION MODULE
// ===========================================

/**
 * Calculate Average True Range from OHLC candles
 * ATR measures volatility based on price ranges
 * 
 * Formula: ATR = SMA of True Range over N periods
 * True Range = max(high - low, |high - prevClose|, |low - prevClose|)
 */
function calculateATR(candles, length = TRADING_CONFIG.atrLength) {
    if (candles.length < 2) {
        return 0;
    }

    const trueRanges = [];
    const lookback = Math.min(candles.length, length + 1);

    for (let i = 1; i < lookback; i++) {
        const current = candles[candles.length - lookback + i];
        const previous = candles[candles.length - lookback + i - 1];

        // True Range calculation
        const highLow = current.high - current.low;
        const highPrevClose = Math.abs(current.high - previous.close);
        const lowPrevClose = Math.abs(current.low - previous.close);

        const trueRange = Math.max(highLow, highPrevClose, lowPrevClose);
        trueRanges.push(trueRange);
    }

    if (trueRanges.length === 0) {
        return 0;
    }

    // Simple Moving Average of True Ranges
    const atr = trueRanges.reduce((sum, tr) => sum + tr, 0) / trueRanges.length;
    return atr;
}


// ===========================================
// 4. QUOTE CALCULATION MODULE
// ===========================================

/**
 * Round price to asset's tick size
 * BTC prices are always integers
 */
function roundPrice(price, config) {
    if (config.decimals === 0) {
        return Math.round(price);
    }
    return Math.round(price / config.tickSize) * config.tickSize;
}

/**
 * Format price for display
 */
function formatPrice(price, config) {
    return '$' + price.toFixed(config.decimals).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * Calculate bid and ask quotes using volatility-adaptive, inventory-aware logic
 * 
 * FORMULA BREAKDOWN:
 * 1. min_spread = tick_size × 2
 * 2. base_spread = max(min_spread, k_vol × vol)
 * 3. pos = long_size - short_size
 * 4. imbalance = pos / pos_max
 * 5. skew = k_pos × imbalance × base_spread
 * 6. bid = mid - base_spread/2 - skew
 * 7. ask = mid + base_spread/2 - skew
 */
function calculateQuotes(mid, atr, longSize, shortSize, config) {
    // 1. Minimum spread = 2 ticks
    const minSpread = config.tickSize * 2;

    // 2. Base spread = max(min_spread, k_vol × ATR)
    const baseSpread = Math.max(minSpread, config.kVol * atr);

    // 3. Net position (positive = net long, negative = net short)
    const netPosition = longSize - shortSize;

    // 4. Position imbalance as percentage of max position
    const imbalance = netPosition / config.maxPosition;

    // 5. Skew moves both quotes in same direction based on inventory
    // Positive imbalance (net long) → negative skew → lower bid/ask to attract sellers
    const skew = config.kPos * imbalance * baseSpread;

    // 6 & 7. Final quote calculation
    const bidPrice = roundPrice(mid - baseSpread / 2 - skew, config);
    const askPrice = roundPrice(mid + baseSpread / 2 - skew, config);

    // Actual spread (may differ slightly due to rounding)
    const actualSpread = askPrice - bidPrice;

    return {
        bid: bidPrice,
        ask: askPrice,
        baseSpread: baseSpread,
        actualSpread: actualSpread,
        skew: skew,
        imbalance: imbalance
    };
}


// ===========================================
// 5. PRICE SIMULATION MODULE
// ===========================================

/**
 * Simulates price movements using Geometric Brownian Motion
 * with configurable drift and volatility regimes
 */
class PriceSimulator {
    constructor(asset, rng) {
        this.asset = asset;
        this.config = ASSET_CONFIGS[asset];
        this.rng = rng;
        this.currentPrice = this.config.initPrice;
        this.volatilityRegime = 'medium';
        this.drift = 0;
        this.candles = [];
        this.currentCandle = null;
        this.candleStartTime = null;
    }

    /**
     * Set volatility regime (low/medium/high)
     */
    setVolatilityRegime(regime) {
        this.volatilityRegime = regime;
    }

    /**
     * Set price drift (positive = uptrend, negative = downtrend)
     */
    setDrift(drift) {
        this.drift = drift;
    }

    /**
     * Reset simulator to initial state
     */
    reset() {
        this.currentPrice = this.config.initPrice;
        this.candles = [];
        this.currentCandle = null;
        this.candleStartTime = null;
        this.rng.reset();
    }

    /**
     * Generate next price tick using GBM
     * dS = μ*S*dt + σ*S*dW
     * 
     * where:
     * - μ = drift (annualized return)
     * - σ = volatility
     * - dW = Wiener process increment
     */
    generateTick(dt = 1.5 / 86400) { // dt in days (1.5 seconds)
        const regimeFactor = VOLATILITY_REGIMES[this.volatilityRegime].factor;
        
        // Base volatility varies by asset
        const baseVol = {
            BTC: 0.6,   // ~60% annual vol
            ETH: 0.8,   // ~80% annual vol
            SOL: 1.0,   // ~100% annual vol
            APT: 1.2    // ~120% annual vol
        }[this.asset];

        const volatility = baseVol * regimeFactor;
        const driftComponent = this.drift * this.currentPrice * dt;
        const randomComponent = volatility * this.currentPrice * Math.sqrt(dt) * this.rng.randomNormal();

        this.currentPrice += driftComponent + randomComponent;
        this.currentPrice = Math.max(this.currentPrice, this.config.tickSize); // Prevent negative prices

        // Update or create candle
        this.updateCandle(this.currentPrice);

        return this.currentPrice;
    }

    /**
     * Update current candle or start new one based on time
     */
    updateCandle(price) {
        const now = Date.now();

        if (!this.candleStartTime || now - this.candleStartTime >= TRADING_CONFIG.candleDurationMs) {
            // Complete current candle and start new one
            if (this.currentCandle) {
                this.candles.push({...this.currentCandle});
                // Keep only last 50 candles for memory efficiency
                if (this.candles.length > 50) {
                    this.candles.shift();
                }
            }

            this.currentCandle = {
                open: price,
                high: price,
                low: price,
                close: price,
                timestamp: now
            };
            this.candleStartTime = now;
        } else {
            // Update existing candle
            this.currentCandle.high = Math.max(this.currentCandle.high, price);
            this.currentCandle.low = Math.min(this.currentCandle.low, price);
            this.currentCandle.close = price;
        }
    }

    /**
     * Get all completed candles for ATR calculation
     */
    getCandles() {
        return this.candles;
    }

    /**
     * Get current ATR value
     */
    getATR(length) {
        return calculateATR(this.candles, length);
    }
}


// ===========================================
// 6. LIVE PRICE MODULE
// ===========================================

/**
 * Fetches live prices from CoinGecko API
 */
class LivePriceFetcher {
    constructor() {
        this.lastPrice = null;
        this.candles = [];
        this.currentCandle = null;
        this.candleStartTime = null;
        this.isLoading = false;
        this.lastFetchTime = 0;
    }

    /**
     * Fetch current price for asset from CoinGecko
     */
    async fetchPrice(coinId) {
        // Rate limiting: minimum 3 seconds between requests
        const now = Date.now();
        if (now - this.lastFetchTime < 3000) {
            return this.lastPrice;
        }

        this.isLoading = true;
        this.lastFetchTime = now;

        try {
            const url = `https://api.coingecko.com/api/v3/simple/price?ids=${coinId}&vs_currencies=usd`;
            const response = await fetch(url);
            
            if (!response.ok) {
                console.warn('CoinGecko API error:', response.status);
                return this.lastPrice;
            }

            const data = await response.json();

            if (data && data[coinId] && data[coinId].usd) {
                const price = data[coinId].usd;
                this.lastPrice = price;
                this.updateCandle(price);
                return price;
            }
        } catch (error) {
            console.error('Error fetching live price:', error);
        } finally {
            this.isLoading = false;
        }

        return this.lastPrice;
    }

    /**
     * Update candle data from live prices (same logic as simulation)
     */
    updateCandle(price) {
        const now = Date.now();

        if (!this.candleStartTime || now - this.candleStartTime >= TRADING_CONFIG.candleDurationMs) {
            if (this.currentCandle) {
                this.candles.push({...this.currentCandle});
                if (this.candles.length > 50) {
                    this.candles.shift();
                }
            }

            this.currentCandle = {
                open: price,
                high: price,
                low: price,
                close: price,
                timestamp: now
            };
            this.candleStartTime = now;
        } else {
            this.currentCandle.high = Math.max(this.currentCandle.high, price);
            this.currentCandle.low = Math.min(this.currentCandle.low, price);
            this.currentCandle.close = price;
        }
    }

    /**
     * Get candles for ATR calculation
     */
    getCandles() {
        return this.candles;
    }

    /**
     * Reset all data
     */
    reset() {
        this.lastPrice = null;
        this.candles = [];
        this.currentCandle = null;
        this.candleStartTime = null;
    }
}


// ===========================================
// 7. TRADING ENGINE MODULE
// ===========================================

/**
 * Core trading engine handling positions, margin, and collapses
 */
class TradingEngine {
    constructor() {
        this.reset();
    }

    /**
     * Reset all trading state
     */
    reset(initialBalance = TRADING_CONFIG.defaultBalance) {
        this.balance = initialBalance;
        this.initialBalance = initialBalance;
        this.leverage = TRADING_CONFIG.leverage;
        
        this.longPosition = { size: 0, avgPrice: 0 };
        this.shortPosition = { size: 0, avgPrice: 0 };
        
        this.realizedPnL = 0;
        this.trades = [];
        this.collapses = [];
    }

    /**
     * Calculate margin required for a trade
     * margin = size × price / leverage
     */
    calculateMargin(size, price) {
        return (size * price) / this.leverage;
    }

    /**
     * Calculate order size based on $50 notional
     */
    calculateOrderSize(price) {
        const buyingPower = this.balance * this.leverage;
        const maxNotional = Math.min(TRADING_CONFIG.orderSizeUSD, buyingPower);
        return maxNotional / price;
    }

    /**
     * Execute entry order (long or short)
     * Returns trade object or null if insufficient margin
     */
    executeEntry(side, price, size, timestamp = new Date()) {
        const margin = this.calculateMargin(size, price);

        // Check available margin
        if (margin > this.balance) {
            return null;
        }

        // Deduct margin from balance
        this.balance -= margin;

        if (side === 'LONG') {
            // Update long position with weighted average price
            const newSize = this.longPosition.size + size;
            const newAvgPrice = this.longPosition.size > 0
                ? (this.longPosition.avgPrice * this.longPosition.size + price * size) / newSize
                : price;
            
            this.longPosition = { size: newSize, avgPrice: newAvgPrice };
        } else {
            // Update short position
            const newSize = this.shortPosition.size + size;
            const newAvgPrice = this.shortPosition.size > 0
                ? (this.shortPosition.avgPrice * this.shortPosition.size + price * size) / newSize
                : price;
            
            this.shortPosition = { size: newSize, avgPrice: newAvgPrice };
        }

        // Record trade
        const trade = {
            id: this.trades.length + 1,
            timestamp: timestamp.toLocaleTimeString(),
            isoTimestamp: timestamp.toISOString(),
            side: side,
            price: price,
            size: size,
            margin: margin
        };

        this.trades.unshift(trade);
        
        // Keep last 100 trades in memory
        if (this.trades.length > 100) {
            this.trades.pop();
        }

        return trade;
    }

    /**
     * Check if collapse should trigger
     * Collapse when balance < $100 and both positions exist
     */
    shouldCollapse() {
        return this.balance < TRADING_CONFIG.collapseThreshold 
            && this.longPosition.size > 0 
            && this.shortPosition.size > 0;
    }

    /**
     * Execute collapse (internal position netting)
     * 
     * COLLAPSE MECHANICS:
     * 1. collapse_size = min(long_size, short_size)
     * 2. pnl = (short_avg_price - long_avg_price) × collapse_size
     * 3. Return margin for collapsed positions
     * 4. Add realized PnL to balance
     */
    executeCollapse(timestamp = new Date()) {
        const collapseSize = Math.min(this.longPosition.size, this.shortPosition.size);
        
        if (collapseSize <= 0) {
            return null;
        }

        // Calculate realized PnL from collapse
        // PnL = (short_avg_price - long_avg_price) × collapse_size
        const pnl = (this.shortPosition.avgPrice - this.longPosition.avgPrice) * collapseSize;

        // Calculate margin to return
        const longMarginReturn = this.calculateMargin(collapseSize, this.longPosition.avgPrice);
        const shortMarginReturn = this.calculateMargin(collapseSize, this.shortPosition.avgPrice);

        // Update positions
        const newLongSize = this.longPosition.size - collapseSize;
        const newShortSize = this.shortPosition.size - collapseSize;

        this.longPosition = {
            size: newLongSize,
            avgPrice: newLongSize > 0 ? this.longPosition.avgPrice : 0
        };

        this.shortPosition = {
            size: newShortSize,
            avgPrice: newShortSize > 0 ? this.shortPosition.avgPrice : 0
        };

        // Update balance: return margin + add PnL
        this.balance += longMarginReturn + shortMarginReturn + pnl;
        this.realizedPnL += pnl;

        // Record collapse event
        const collapse = {
            id: this.collapses.length + 1,
            timestamp: timestamp.toLocaleTimeString(),
            isoTimestamp: timestamp.toISOString(),
            size: collapseSize,
            pnl: pnl
        };

        this.collapses.unshift(collapse);

        return collapse;
    }

    /**
     * Calculate unrealized PnL for both positions
     */
    calculateUnrealizedPnL(currentPrice) {
        const longPnL = this.longPosition.size > 0
            ? this.longPosition.size * (currentPrice - this.longPosition.avgPrice)
            : 0;

        const shortPnL = this.shortPosition.size > 0
            ? this.shortPosition.size * (this.shortPosition.avgPrice - currentPrice)
            : 0;

        return longPnL + shortPnL;
    }

    /**
     * Calculate total equity
     * equity = balance + long_margin + short_margin + unrealized_pnl
     */
    calculateEquity(currentPrice) {
        const longMargin = this.calculateMargin(this.longPosition.size, this.longPosition.avgPrice);
        const shortMargin = this.calculateMargin(this.shortPosition.size, this.shortPosition.avgPrice);
        const unrealizedPnL = this.calculateUnrealizedPnL(currentPrice);

        return this.balance + longMargin + shortMargin + unrealizedPnL;
    }

    /**
     * Get current state snapshot for export
     */
    getState() {
        return {
            balance: this.balance,
            longPosition: {...this.longPosition},
            shortPosition: {...this.shortPosition},
            realizedPnL: this.realizedPnL,
            tradesCount: this.trades.length,
            collapsesCount: this.collapses.length
        };
    }
}


// ===========================================
// 8. SIMULATION ENGINE MODULE
// ===========================================

/**
 * Main simulation engine coordinating all components
 */
class SimulationEngine {
    constructor() {
        this.rng = new SeededRNG();
        this.priceSimulator = null;
        this.livePriceFetcher = new LivePriceFetcher();
        this.tradingEngine = new TradingEngine();
        
        this.mode = 'simulation';  // 'simulation' or 'live'
        this.asset = 'BTC';
        this.config = ASSET_CONFIGS.BTC;
        this.isRunning = false;
        this.intervalId = null;
        this.tickCount = 0;
        this.atrLength = TRADING_CONFIG.atrLength;
        
        // Data history for charts and export
        this.dataHistory = [];
        
        // Current state
        this.currentMid = 0;
        this.currentQuotes = { bid: 0, ask: 0, baseSpread: 0, actualSpread: 0, skew: 0, imbalance: 0 };
        this.currentATR = 0;
    }

    /**
     * Initialize with specific asset
     */
    setAsset(asset) {
        this.asset = asset;
        this.config = ASSET_CONFIGS[asset];
        this.priceSimulator = new PriceSimulator(asset, this.rng);
        this.livePriceFetcher.reset();
    }

    /**
     * Set simulation mode
     */
    setMode(mode) {
        this.mode = mode;
    }

    /**
     * Set RNG seed for reproducibility
     */
    setSeed(seed) {
        this.rng.setSeed(seed);
        if (this.priceSimulator) {
            this.priceSimulator.rng = this.rng;
        }
    }

    /**
     * Set ATR calculation length
     */
    setATRLength(length) {
        this.atrLength = Math.max(5, Math.min(50, length));
    }

    /**
     * Update asset configuration parameters
     */
    updateConfig(params) {
        if (params.kVol !== undefined) this.config.kVol = params.kVol;
        if (params.kPos !== undefined) this.config.kPos = params.kPos;
        if (params.tickSize !== undefined) this.config.tickSize = params.tickSize;
        if (params.maxPosition !== undefined) this.config.maxPosition = params.maxPosition;
    }

    /**
     * Set volatility regime for simulation mode
     */
    setVolatilityRegime(regime) {
        if (this.priceSimulator) {
            this.priceSimulator.setVolatilityRegime(regime);
        }
    }

    /**
     * Set price drift for simulation mode
     */
    setDrift(drift) {
        if (this.priceSimulator) {
            this.priceSimulator.setDrift(drift);
        }
    }

    /**
     * Reset entire simulation state
     */
    reset(initialBalance) {
        this.stop();
        this.tickCount = 0;
        this.dataHistory = [];
        this.currentMid = 0;
        this.currentATR = 0;
        this.currentQuotes = { bid: 0, ask: 0, baseSpread: 0, actualSpread: 0, skew: 0, imbalance: 0 };
        
        this.tradingEngine.reset(initialBalance);
        this.rng.reset();
        
        if (this.priceSimulator) {
            this.priceSimulator.reset();
        }
        this.livePriceFetcher.reset();
    }

    /**
     * Start simulation/live trading
     */
    async start() {
        if (this.isRunning) return;
        
        this.isRunning = true;
        
        // Initial price fetch in live mode
        if (this.mode === 'live') {
            const price = await this.livePriceFetcher.fetchPrice(this.config.coinId);
            if (price) {
                this.currentMid = price;
            }
        }

        // Main loop
        const tickInterval = this.mode === 'simulation' 
            ? TRADING_CONFIG.tickIntervalMs 
            : TRADING_CONFIG.priceUpdateIntervalMs;

        this.intervalId = setInterval(() => this.tick(), tickInterval);
        
        // Run first tick immediately
        this.tick();
    }

    /**
     * Stop simulation
     */
    stop() {
        this.isRunning = false;
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = null;
        }
    }

    /**
     * Main tick function - called every interval
     */
    async tick() {
        if (!this.isRunning) return;

        this.tickCount++;
        const timestamp = new Date();

        // 1. Get current price
        if (this.mode === 'simulation') {
            this.currentMid = this.priceSimulator.generateTick();
        } else {
            const price = await this.livePriceFetcher.fetchPrice(this.config.coinId);
            if (price) {
                this.currentMid = price;
            }
        }

        // 2. Calculate ATR from candles
        const candles = this.mode === 'simulation' 
            ? this.priceSimulator.getCandles()
            : this.livePriceFetcher.getCandles();
        
        this.currentATR = calculateATR(candles, this.atrLength);

        // 3. Check for collapse condition
        if (this.tradingEngine.shouldCollapse()) {
            const collapse = this.tradingEngine.executeCollapse(timestamp);
            if (collapse) {
                this.onCollapse(collapse);
            }
        }

        // 4. Calculate quotes
        this.currentQuotes = calculateQuotes(
            this.currentMid,
            this.currentATR,
            this.tradingEngine.longPosition.size,
            this.tradingEngine.shortPosition.size,
            this.config
        );

        // 5. Simulate market activity (random fills)
        this.simulateMarketActivity(timestamp);

        // 6. Calculate metrics
        const unrealizedPnL = this.tradingEngine.calculateUnrealizedPnL(this.currentMid);
        const equity = this.tradingEngine.calculateEquity(this.currentMid);

        // 7. Record data point
        const dataPoint = {
            timestamp: timestamp.toISOString(),
            tick: this.tickCount,
            mid: this.currentMid,
            bid: this.currentQuotes.bid,
            ask: this.currentQuotes.ask,
            spread: this.currentQuotes.actualSpread,
            atr: this.currentATR,
            balance: this.tradingEngine.balance,
            equity: equity,
            unrealizedPnL: unrealizedPnL,
            realizedPnL: this.tradingEngine.realizedPnL,
            longSize: this.tradingEngine.longPosition.size,
            shortSize: this.tradingEngine.shortPosition.size
        };

        this.dataHistory.push(dataPoint);

        // Keep only last 1000 data points in memory
        if (this.dataHistory.length > 1000) {
            this.dataHistory.shift();
        }

        // 8. Trigger UI update callback
        if (this.onTick) {
            this.onTick(dataPoint);
        }
    }

    /**
     * Simulate random market activity
     * Fills occur probabilistically based on spread and volatility
     */
    simulateMarketActivity(timestamp) {
        // Base fill probability: 25%
        const fillProbability = 0.25;
        
        if (this.rng.random() > fillProbability) {
            return;
        }

        // Determine side (50/50 buy/sell)
        const isBuyOrder = this.rng.random() < 0.5;
        
        // Partial fills: 50-100% of order size
        const fillPercentage = 0.5 + this.rng.random() * 0.5;

        if (isBuyOrder) {
            // Market buy hits our ask → we sell → enter short
            const orderSize = this.tradingEngine.calculateOrderSize(this.currentQuotes.ask);
            const fillSize = orderSize * fillPercentage;
            const trade = this.tradingEngine.executeEntry('SHORT', this.currentQuotes.ask, fillSize, timestamp);
            
            if (trade && this.onTrade) {
                this.onTrade(trade);
            }
        } else {
            // Market sell hits our bid → we buy → enter long
            const orderSize = this.tradingEngine.calculateOrderSize(this.currentQuotes.bid);
            const fillSize = orderSize * fillPercentage;
            const trade = this.tradingEngine.executeEntry('LONG', this.currentQuotes.bid, fillSize, timestamp);
            
            if (trade && this.onTrade) {
                this.onTrade(trade);
            }
        }
    }

    /**
     * Export data as CSV
     */
    exportCSV() {
        if (this.dataHistory.length === 0) {
            return null;
        }

        const headers = Object.keys(this.dataHistory[0]);
        const rows = this.dataHistory.map(row => 
            headers.map(h => {
                const val = row[h];
                return typeof val === 'number' ? val.toFixed(8) : val;
            }).join(',')
        );

        return [headers.join(','), ...rows].join('\n');
    }

    /**
     * Export data as JSON
     */
    exportJSON() {
        return JSON.stringify({
            asset: this.asset,
            mode: this.mode,
            config: this.config,
            trades: this.tradingEngine.trades,
            collapses: this.tradingEngine.collapses,
            history: this.dataHistory,
            finalState: this.tradingEngine.getState()
        }, null, 2);
    }

    // Callbacks (to be set by UI controller)
    onTick = null;
    onTrade = null;
    onCollapse = null;
}


// ===========================================
// 9. CHART MODULE
// ===========================================

/**
 * Manages all charts using Lightweight Charts library
 */
class ChartManager {
    constructor() {
        this.priceChart = null;
        this.priceSeries = null;
        this.bidSeries = null;
        this.askSeries = null;
        
        this.equityChart = null;
        this.equitySeries = null;
        
        this.pnlChart = null;
        this.realizedSeries = null;
        this.unrealizedSeries = null;
        
        this.chartOptions = {
            layout: {
                background: { color: '#161b22' },
                textColor: '#8b949e'
            },
            grid: {
                vertLines: { color: '#30363d' },
                horzLines: { color: '#30363d' }
            },
            timeScale: {
                borderColor: '#30363d',
                timeVisible: true,
                secondsVisible: true
            },
            rightPriceScale: {
                borderColor: '#30363d'
            },
            crosshair: {
                mode: LightweightCharts.CrosshairMode.Normal
            }
        };
    }

    /**
     * Initialize all charts
     */
    initialize() {
        this.initPriceChart();
        this.initEquityChart();
        this.initPnLChart();
    }

    /**
     * Initialize price chart with bid/ask lines
     */
    initPriceChart() {
        const container = document.getElementById('price-chart');
        if (!container) return;

        this.priceChart = LightweightCharts.createChart(container, {
            ...this.chartOptions,
            width: container.clientWidth,
            height: 250
        });

        // Mid price line
        this.priceSeries = this.priceChart.addLineSeries({
            color: '#58a6ff',
            lineWidth: 2,
            title: 'Mid'
        });

        // Bid line
        this.bidSeries = this.priceChart.addLineSeries({
            color: '#3fb950',
            lineWidth: 1,
            lineStyle: LightweightCharts.LineStyle.Dashed,
            title: 'Bid'
        });

        // Ask line
        this.askSeries = this.priceChart.addLineSeries({
            color: '#f85149',
            lineWidth: 1,
            lineStyle: LightweightCharts.LineStyle.Dashed,
            title: 'Ask'
        });

        // Handle resize
        window.addEventListener('resize', () => {
            if (this.priceChart) {
                this.priceChart.applyOptions({ width: container.clientWidth });
            }
        });
    }

    /**
     * Initialize equity curve chart
     */
    initEquityChart() {
        const container = document.getElementById('equity-chart');
        if (!container) return;

        this.equityChart = LightweightCharts.createChart(container, {
            ...this.chartOptions,
            width: container.clientWidth,
            height: 250
        });

        this.equitySeries = this.equityChart.addAreaSeries({
            topColor: 'rgba(88, 166, 255, 0.4)',
            bottomColor: 'rgba(88, 166, 255, 0.0)',
            lineColor: '#58a6ff',
            lineWidth: 2
        });

        window.addEventListener('resize', () => {
            if (this.equityChart) {
                this.equityChart.applyOptions({ width: container.clientWidth });
            }
        });
    }

    /**
     * Initialize PnL chart
     */
    initPnLChart() {
        const container = document.getElementById('pnl-chart');
        if (!container) return;

        this.pnlChart = LightweightCharts.createChart(container, {
            ...this.chartOptions,
            width: container.clientWidth,
            height: 250
        });

        this.realizedSeries = this.pnlChart.addLineSeries({
            color: '#a371f7',
            lineWidth: 2,
            title: 'Realized'
        });

        this.unrealizedSeries = this.pnlChart.addLineSeries({
            color: '#8b949e',
            lineWidth: 1,
            lineStyle: LightweightCharts.LineStyle.Dashed,
            title: 'Unrealized'
        });

        window.addEventListener('resize', () => {
            if (this.pnlChart) {
                this.pnlChart.applyOptions({ width: container.clientWidth });
            }
        });
    }

    /**
     * Update charts with new data point
     */
    update(dataPoint) {
        const time = Math.floor(new Date(dataPoint.timestamp).getTime() / 1000);

        if (this.priceSeries) {
            this.priceSeries.update({ time, value: dataPoint.mid });
        }
        if (this.bidSeries) {
            this.bidSeries.update({ time, value: dataPoint.bid });
        }
        if (this.askSeries) {
            this.askSeries.update({ time, value: dataPoint.ask });
        }
        if (this.equitySeries) {
            this.equitySeries.update({ time, value: dataPoint.equity });
        }
        if (this.realizedSeries) {
            this.realizedSeries.update({ time, value: dataPoint.realizedPnL });
        }
        if (this.unrealizedSeries) {
            this.unrealizedSeries.update({ time, value: dataPoint.unrealizedPnL });
        }
    }

    /**
     * Clear all chart data
     */
    clear() {
        if (this.priceSeries) this.priceSeries.setData([]);
        if (this.bidSeries) this.bidSeries.setData([]);
        if (this.askSeries) this.askSeries.setData([]);
        if (this.equitySeries) this.equitySeries.setData([]);
        if (this.realizedSeries) this.realizedSeries.setData([]);
        if (this.unrealizedSeries) this.unrealizedSeries.setData([]);
    }
}


// ===========================================
// 10. UI CONTROLLER MODULE
// ===========================================

/**
 * Manages all UI interactions and updates
 */
class UIController {
    constructor(engine, charts) {
        this.engine = engine;
        this.charts = charts;
        this.elements = {};
        
        this.cacheElements();
        this.bindEvents();
        this.setInitialState();
    }

    /**
     * Cache DOM element references for performance
     */
    cacheElements() {
        // Mode buttons
        this.elements.btnSimulation = document.getElementById('btn-simulation');
        this.elements.btnLive = document.getElementById('btn-live');
        
        // Control buttons
        this.elements.btnStart = document.getElementById('btn-start');
        this.elements.btnStop = document.getElementById('btn-stop');
        this.elements.btnReset = document.getElementById('btn-reset');
        this.elements.btnCSV = document.getElementById('btn-csv');
        this.elements.btnJSON = document.getElementById('btn-json');
        
        // Inputs
        this.elements.assetSelector = document.getElementById('asset-selector');
        this.elements.initialBalance = document.getElementById('initial-balance');
        this.elements.paramKvol = document.getElementById('param-kvol');
        this.elements.paramKpos = document.getElementById('param-kpos');
        this.elements.paramTicksize = document.getElementById('param-ticksize');
        this.elements.paramMaxpos = document.getElementById('param-maxpos');
        this.elements.volatilityRegime = document.getElementById('volatility-regime');
        this.elements.paramDrift = document.getElementById('param-drift');
        this.elements.paramAtrLength = document.getElementById('param-atr-length');
        this.elements.paramSeed = document.getElementById('param-seed');
        
        // Metrics - Account
        this.elements.metricBalance = document.getElementById('metric-balance');
        this.elements.metricEquity = document.getElementById('metric-equity');
        this.elements.metricUnrealizedPnl = document.getElementById('metric-unrealized-pnl');
        this.elements.metricRealizedPnl = document.getElementById('metric-realized-pnl');
        
        // Metrics - Market
        this.elements.metricMid = document.getElementById('metric-mid');
        this.elements.metricBid = document.getElementById('metric-bid');
        this.elements.metricAsk = document.getElementById('metric-ask');
        this.elements.metricBidSize = document.getElementById('metric-bid-size');
        this.elements.metricAskSize = document.getElementById('metric-ask-size');
        this.elements.metricSpread = document.getElementById('metric-spread');
        this.elements.metricAtr = document.getElementById('metric-atr');
        this.elements.metricBaseSpread = document.getElementById('metric-base-spread');
        this.elements.metricSkew = document.getElementById('metric-skew');
        this.elements.metricImbalance = document.getElementById('metric-imbalance');
        
        // Positions
        this.elements.longSize = document.getElementById('long-size');
        this.elements.longAvgPrice = document.getElementById('long-avg-price');
        this.elements.longMargin = document.getElementById('long-margin');
        this.elements.shortSize = document.getElementById('short-size');
        this.elements.shortAvgPrice = document.getElementById('short-avg-price');
        this.elements.shortMargin = document.getElementById('short-margin');
        
        // Tables
        this.elements.tradesTbody = document.getElementById('trades-tbody');
        this.elements.collapsesTbody = document.getElementById('collapses-tbody');
        this.elements.tradeCount = document.getElementById('trade-count');
        this.elements.collapseCount = document.getElementById('collapse-count');
        
        // Status bar
        this.elements.statusMode = document.getElementById('status-mode');
        this.elements.statusAsset = document.getElementById('status-asset');
        this.elements.statusRunning = document.getElementById('status-running');
        this.elements.statusTick = document.getElementById('status-tick');
    }

    /**
     * Bind all event listeners
     */
    bindEvents() {
        // Mode toggle
        this.elements.btnSimulation.addEventListener('click', () => this.setMode('simulation'));
        this.elements.btnLive.addEventListener('click', () => this.setMode('live'));
        
        // Control buttons
        this.elements.btnStart.addEventListener('click', () => this.start());
        this.elements.btnStop.addEventListener('click', () => this.stop());
        this.elements.btnReset.addEventListener('click', () => this.reset());
        this.elements.btnCSV.addEventListener('click', () => this.downloadCSV());
        this.elements.btnJSON.addEventListener('click', () => this.downloadJSON());
        
        // Asset selector
        this.elements.assetSelector.addEventListener('change', (e) => this.changeAsset(e.target.value));
        
        // Parameter inputs
        this.elements.paramKvol.addEventListener('change', () => this.updateParams());
        this.elements.paramKpos.addEventListener('change', () => this.updateParams());
        this.elements.paramTicksize.addEventListener('change', () => this.updateParams());
        this.elements.paramMaxpos.addEventListener('change', () => this.updateParams());
        this.elements.volatilityRegime.addEventListener('change', (e) => {
            this.engine.setVolatilityRegime(e.target.value);
        });
        this.elements.paramDrift.addEventListener('change', (e) => {
            this.engine.setDrift(parseFloat(e.target.value) || 0);
        });
        this.elements.paramAtrLength.addEventListener('change', (e) => {
            this.engine.setATRLength(parseInt(e.target.value) || 20);
        });
        this.elements.paramSeed.addEventListener('change', (e) => {
            this.engine.setSeed(parseInt(e.target.value) || 12345);
        });

        // Engine callbacks
        this.engine.onTick = (dataPoint) => this.handleTick(dataPoint);
        this.engine.onTrade = (trade) => this.handleTrade(trade);
        this.engine.onCollapse = (collapse) => this.handleCollapse(collapse);
    }

    /**
     * Set initial UI state
     */
    setInitialState() {
        this.engine.setAsset('BTC');
        this.engine.setMode('simulation');
        this.updateAssetParams('BTC');
        this.updateStatusBar();
    }

    /**
     * Switch between simulation and live mode
     */
    setMode(mode) {
        if (this.engine.isRunning) {
            alert('Please stop the simulation first');
            return;
        }

        this.engine.setMode(mode);
        
        this.elements.btnSimulation.classList.toggle('active', mode === 'simulation');
        this.elements.btnLive.classList.toggle('active', mode === 'live');
        
        document.body.classList.toggle('live-mode', mode === 'live');
        
        this.updateStatusBar();
    }

    /**
     * Change trading asset
     */
    changeAsset(asset) {
        if (this.engine.isRunning) {
            alert('Please stop the simulation first');
            return;
        }

        this.engine.setAsset(asset);
        this.updateAssetParams(asset);
        this.reset();
        this.updateStatusBar();
    }

    /**
     * Update parameter inputs for selected asset
     */
    updateAssetParams(asset) {
        const config = ASSET_CONFIGS[asset];
        this.elements.paramKvol.value = config.kVol;
        this.elements.paramKpos.value = config.kPos;
        this.elements.paramTicksize.value = config.tickSize;
        this.elements.paramMaxpos.value = config.maxPosition;
    }

    /**
     * Update engine with current parameter values
     */
    updateParams() {
        this.engine.updateConfig({
            kVol: parseFloat(this.elements.paramKvol.value) || 0.2,
            kPos: parseFloat(this.elements.paramKpos.value) || 0.3,
            tickSize: parseFloat(this.elements.paramTicksize.value) || 1,
            maxPosition: parseFloat(this.elements.paramMaxpos.value) || 0.5
        });
    }

    /**
     * Start simulation
     */
    async start() {
        // Apply current parameters
        this.updateParams();
        
        const initialBalance = parseFloat(this.elements.initialBalance.value) || 1000;
        if (this.engine.dataHistory.length === 0) {
            this.engine.reset(initialBalance);
        }

        this.setControlsEnabled(false);
        this.elements.btnStart.disabled = true;
        this.elements.btnStop.disabled = false;
        
        document.body.classList.add('running');
        
        await this.engine.start();
        this.updateStatusBar();
    }

    /**
     * Stop simulation
     */
    stop() {
        this.engine.stop();
        
        this.setControlsEnabled(true);
        this.elements.btnStart.disabled = false;
        this.elements.btnStop.disabled = true;
        
        document.body.classList.remove('running');
        this.updateStatusBar();
    }

    /**
     * Reset simulation
     */
    reset() {
        this.stop();
        
        const initialBalance = parseFloat(this.elements.initialBalance.value) || 1000;
        this.engine.reset(initialBalance);
        
        // Clear UI
        this.elements.tradesTbody.innerHTML = '<tr class="empty-row"><td colspan="5">No trades yet</td></tr>';
        this.elements.collapsesTbody.innerHTML = '<tr class="empty-row"><td colspan="3">No collapses yet</td></tr>';
        this.elements.tradeCount.textContent = '0';
        this.elements.collapseCount.textContent = '0';
        
        // Reset metrics display
        this.updateMetrics({
            balance: initialBalance,
            equity: initialBalance,
            unrealizedPnL: 0,
            realizedPnL: 0,
            mid: 0,
            bid: 0,
            ask: 0
        });
        
        // Clear charts
        this.charts.clear();
        
        this.updateStatusBar();
    }

    /**
     * Enable/disable controls during simulation
     */
    setControlsEnabled(enabled) {
        const controls = [
            this.elements.assetSelector,
            this.elements.initialBalance,
            this.elements.paramKvol,
            this.elements.paramKpos,
            this.elements.paramTicksize,
            this.elements.paramMaxpos,
            this.elements.volatilityRegime,
            this.elements.paramDrift,
            this.elements.paramAtrLength,
            this.elements.paramSeed
        ];

        controls.forEach(el => {
            if (el) el.disabled = !enabled;
        });
    }

    /**
     * Handle tick update from engine
     */
    handleTick(dataPoint) {
        this.updateMetrics(dataPoint);
        this.charts.update(dataPoint);
        this.updateStatusBar();
        
        // Low balance warning
        const accountCard = document.querySelector('.account-metrics');
        if (dataPoint.balance < TRADING_CONFIG.collapseThreshold * 1.2) {
            accountCard.classList.add('low-balance-warning');
        } else {
            accountCard.classList.remove('low-balance-warning');
        }
    }

    /**
     * Handle new trade from engine
     */
    handleTrade(trade) {
        // Remove empty row if exists
        const emptyRow = this.elements.tradesTbody.querySelector('.empty-row');
        if (emptyRow) {
            emptyRow.remove();
        }

        const row = document.createElement('tr');
        row.className = trade.side === 'LONG' ? 'flash-profit' : 'flash-loss';
        row.innerHTML = `
            <td>${trade.timestamp}</td>
            <td class="${trade.side === 'LONG' ? 'side-long' : 'side-short'}">${trade.side}</td>
            <td>${formatPrice(trade.price, this.engine.config)}</td>
            <td>${trade.size.toFixed(6)}</td>
            <td>$${trade.margin.toFixed(2)}</td>
        `;

        this.elements.tradesTbody.insertBefore(row, this.elements.tradesTbody.firstChild);
        
        // Keep only last 50 rows in DOM
        while (this.elements.tradesTbody.children.length > 50) {
            this.elements.tradesTbody.lastChild.remove();
        }

        this.elements.tradeCount.textContent = this.engine.tradingEngine.trades.length;
    }

    /**
     * Handle collapse event from engine
     */
    handleCollapse(collapse) {
        // Remove empty row if exists
        const emptyRow = this.elements.collapsesTbody.querySelector('.empty-row');
        if (emptyRow) {
            emptyRow.remove();
        }

        const row = document.createElement('tr');
        row.className = collapse.pnl >= 0 ? 'flash-profit' : 'flash-loss';
        row.innerHTML = `
            <td>${collapse.timestamp}</td>
            <td>${collapse.size.toFixed(6)}</td>
            <td class="${collapse.pnl >= 0 ? 'pnl-positive' : 'pnl-negative'}">$${collapse.pnl.toFixed(2)}</td>
        `;

        this.elements.collapsesTbody.insertBefore(row, this.elements.collapsesTbody.firstChild);
        
        this.elements.collapseCount.textContent = this.engine.tradingEngine.collapses.length;
    }

    /**
     * Update all metric displays
     */
    updateMetrics(data) {
        const config = this.engine.config;
        const engine = this.engine.tradingEngine;

        // Account metrics
        this.elements.metricBalance.textContent = '$' + data.balance.toFixed(2);
        this.elements.metricEquity.textContent = '$' + data.equity.toFixed(2);
        
        this.elements.metricUnrealizedPnl.textContent = '$' + data.unrealizedPnL.toFixed(2);
        this.elements.metricUnrealizedPnl.className = 'metric-value ' + 
            (data.unrealizedPnL > 0 ? 'profit' : data.unrealizedPnL < 0 ? 'loss' : 'neutral');
        
        this.elements.metricRealizedPnl.textContent = '$' + data.realizedPnL.toFixed(2);
        this.elements.metricRealizedPnl.className = 'metric-value ' + 
            (data.realizedPnL > 0 ? 'profit' : data.realizedPnL < 0 ? 'loss' : 'neutral');

        // Equity coloring
        const initialBalance = parseFloat(this.elements.initialBalance.value) || 1000;
        this.elements.metricEquity.className = 'metric-value ' + 
            (data.equity > initialBalance ? 'profit' : data.equity < initialBalance ? 'loss' : '');

        // Market metrics
        if (data.mid > 0) {
            this.elements.metricMid.textContent = formatPrice(data.mid, config);
            this.elements.metricBid.textContent = formatPrice(this.engine.currentQuotes.bid, config);
            this.elements.metricAsk.textContent = formatPrice(this.engine.currentQuotes.ask, config);
            
            // Calculate order sizes
            const bidSize = engine.calculateOrderSize(this.engine.currentQuotes.bid);
            const askSize = engine.calculateOrderSize(this.engine.currentQuotes.ask);
            this.elements.metricBidSize.textContent = bidSize.toFixed(6);
            this.elements.metricAskSize.textContent = askSize.toFixed(6);
            
            this.elements.metricSpread.textContent = formatPrice(this.engine.currentQuotes.actualSpread, config);
        }
        
        this.elements.metricAtr.textContent = this.engine.currentATR.toFixed(4);
        this.elements.metricBaseSpread.textContent = this.engine.currentQuotes.baseSpread.toFixed(4);
        this.elements.metricSkew.textContent = this.engine.currentQuotes.skew.toFixed(4);
        this.elements.metricImbalance.textContent = (this.engine.currentQuotes.imbalance * 100).toFixed(2) + '%';

        // Positions
        this.elements.longSize.textContent = engine.longPosition.size.toFixed(6);
        this.elements.longAvgPrice.textContent = engine.longPosition.avgPrice > 0 
            ? formatPrice(engine.longPosition.avgPrice, config) : '$0.00';
        this.elements.longMargin.textContent = '$' + 
            engine.calculateMargin(engine.longPosition.size, engine.longPosition.avgPrice).toFixed(2);

        this.elements.shortSize.textContent = engine.shortPosition.size.toFixed(6);
        this.elements.shortAvgPrice.textContent = engine.shortPosition.avgPrice > 0 
            ? formatPrice(engine.shortPosition.avgPrice, config) : '$0.00';
        this.elements.shortMargin.textContent = '$' + 
            engine.calculateMargin(engine.shortPosition.size, engine.shortPosition.avgPrice).toFixed(2);
    }

    /**
     * Update status bar
     */
    updateStatusBar() {
        this.elements.statusMode.textContent = `Mode: ${this.engine.mode === 'simulation' ? 'Simulation' : 'Live'}`;
        this.elements.statusAsset.textContent = `Asset: ${this.engine.asset}`;
        this.elements.statusRunning.textContent = `Status: ${this.engine.isRunning ? 'Running' : 'Stopped'}`;
        this.elements.statusTick.textContent = `Tick: ${this.engine.tickCount}`;
    }

    /**
     * Download data as CSV
     */
    downloadCSV() {
        const csv = this.engine.exportCSV();
        if (!csv) {
            alert('No data to export');
            return;
        }

        const blob = new Blob([csv], { type: 'text/csv' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `mm_sim_${this.engine.asset}_${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.csv`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    /**
     * Download data as JSON
     */
    downloadJSON() {
        const json = this.engine.exportJSON();
        if (!json) {
            alert('No data to export');
            return;
        }

        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `mm_sim_${this.engine.asset}_${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }
}


// ===========================================
// APPLICATION INITIALIZATION
// ===========================================

/**
 * Initialize application when DOM is ready
 */
document.addEventListener('DOMContentLoaded', () => {
    // Create instances
    const engine = new SimulationEngine();
    const charts = new ChartManager();
    
    // Initialize charts
    charts.initialize();
    
    // Create UI controller (binds everything together)
    const ui = new UIController(engine, charts);
    
    // Log initialization
    console.log('Market Making Simulator initialized');
    console.log('Available assets:', Object.keys(ASSET_CONFIGS));
    console.log('Trading config:', TRADING_CONFIG);
});
