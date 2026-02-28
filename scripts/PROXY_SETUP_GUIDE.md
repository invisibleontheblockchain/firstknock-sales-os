# Proxy Setup Guide for High-Speed Scraping

## What Are Proxies and Why Do You Need Them?

When scraping Redfin (or any website) at high speed:
- Your IP address makes requests to Redfin's servers
- If you make too many requests from one IP, Redfin blocks/rate-limits you
- **Proxies = multiple IP addresses** that rotate so each request comes from a different IP
- This allows 100+ concurrent requests without getting blocked

## Recommended Proxy Providers

### 1. BrightData (Formerly Luminati) - **BEST CHOICE**
- **Website**: brightdata.com
- **Type**: Residential proxies (real home IPs)
- **Price**: ~$15/GB or $500/month unlimited
- **Pros**: Most reliable, never get blocked, excellent support
- **Cons**: Expensive
- **Best for**: Professional/commercial scraping

### 2. Oxylabs
- **Website**: oxylabs.io
- **Type**: Residential + Datacenter
- **Price**: ~$300/month starter plan
- **Pros**: Good balance of price/performance
- **Cons**: Slightly higher failure rate than BrightData

### 3. Smartproxy
- **Website**: smartproxy.com
- **Type**: Residential rotating
- **Price**: $50-100/month for 5-10GB
- **Pros**: Affordable, easy to use
- **Cons**: Limited bandwidth on cheaper plans

### 4. PacketStream
- **Website**: packetstream.io
- **Type**: P2P residential
- **Price**: $1/GB (pay as you go)
- **Pros**: Very cheap, no monthly commitment
- **Cons**: Lower quality, higher failure rate
- **Best for**: Testing/budget projects

### 5. Webshare
- **Website**: webshare.io
- **Type**: Datacenter proxies
- **Price**: Free tier (10 proxies), or $5-20/month
- **Pros**: Very cheap, good for testing
- **Cons**: Easier to detect and block

## Quick Setup Steps

### Step 1: Buy Proxies

**For testing (free/cheap):**
```
1. Go to webshare.io
2. Create free account (get 10 free proxies)
3. Go to "Proxy List" 
4. Download proxy list
```

**For production (recommended):**
```
1. Go to brightdata.com or oxylabs.io
2. Sign up for residential proxy plan
3. Get your proxy credentials
```

### Step 2: Create proxies.txt File

Create a file named `proxies.txt` in the scripts folder:

**Format 1: IP:Port (simple)**
```
192.168.1.1:8080
192.168.1.2:8080
192.168.1.3:8080
```

**Format 2: With username/password**
```
http://username:password@192.168.1.1:8080
http://username:password@192.168.1.2:8080
```

**Format 3: With protocol**
```
http://192.168.1.1:8080
https://192.168.1.2:8080
socks5://192.168.1.3:1080
```

### Step 3: Test Your Proxies

Run the proxy tester:
```bash
cd scripts
python proxy_manager.py --test-proxies proxies.txt --output working_proxies.txt
```

This will:
- Test each proxy
- Show response times
- Save working proxies to `working_proxies.txt`

### Step 4: Run the Scraper

```bash
# Test with a single state first
python county_batch_scraper.py --state CA --workers 50 --proxies working_proxies.txt

# If that works, run full scrape
python county_batch_scraper.py --workers 100 --proxies working_proxies.txt
```

## How Many Proxies Do You Need?

| Workers | Recommended Proxies | Why |
|---------|---------------------|-----|
| 20 | 20-30 | 1:1 ratio is safe |
| 50 | 50-75 | Some proxies may fail |
| 100 | 100-150 | Buffer for failures |
| 200 | 150-200 | Higher reuse acceptable |

**Rule of thumb**: Have at least as many proxies as workers, ideally 1.5x

## Example: Webshare Setup (Free/Cheap)

1. **Sign up at webshare.io**

2. **Get your proxies:**
   - Go to Dashboard → Proxy List
   - You'll see something like:
   ```
   Proxy Address: p.webshare.io
   Port: 80
   Username: your_username
   Password: your_password
   ```

3. **Create proxies.txt:**
   ```
   http://your_username:your_password@p.webshare.io:80
   ```
   
   For multiple proxies (if you bought more):
   ```
   http://your_username:your_password@p.webshare.io:80
   http://your_username:your_password@p.webshare.io:80
   # (Yes, same line multiple times for rotation)
   ```

4. **Test:**
   ```bash
   python proxy_manager.py --test-proxies proxies.txt
   ```

5. **Run:**
   ```bash
   python county_batch_scraper.py --workers 10 --proxies proxies.txt
   ```

## Example: BrightData Setup (Professional)

1. **Sign up at brightdata.com**

2. **Create a proxy zone:**
   - Go to "Proxy Infrastructure"
   - Click "Add Zone"
   - Choose "Residential"
   - Select "Rotating" (changes IP every request)

3. **Get credentials:**
   - Zone name: `your_zone_name`
   - You'll get:
     - Host: `brd.superproxy.io`
     - Port: `22225`
     - Username: `brd-customer-XXXX-zone-your_zone_name`
     - Password: `your_password`

4. **Create proxies.txt:**
   ```
   http://brd-customer-XXXX-zone-your_zone_name:your_password@brd.superproxy.io:22225
   ```

   For 100 concurrent connections, add the line 100 times:
   ```
   http://brd-customer-XXXX-zone-your_zone_name:your_password@brd.superproxy.io:22225
   http://brd-customer-XXXX-zone-your_zone_name:your_password@brd.superproxy.io:22225
   ... (100 times total)
   ```

5. **Run:**
   ```bash
   python county_batch_scraper.py --workers 100 --proxies proxies.txt
   ```

## Troubleshooting

### "All proxies failing"
- Check your proxy credentials are correct
- Test proxies manually with curl:
  ```bash
  curl -x http://username:password@proxy:port https://www.redfin.com
  ```
- Some proxies block certain sites - try a different provider

### "Getting rate limited even with proxies"
- Increase delay: `--delay 0.5` instead of `0.2`
- Use more proxies relative to workers
- Try residential proxies instead of datacenter

### "Proxies too slow"
- Test response times: `python proxy_manager.py --test-proxies proxies.txt`
- Remove slow proxies (>5 seconds)
- Upgrade to better proxy tier

### "Free proxies not working"
- Free proxies are often dead or blocked
- Use paid proxies for reliable scraping
- PacketStream ($1/GB) is cheapest reliable option

## Alternative: No Proxies (Slower but Free)

If you can't use proxies, the scraper will still work with lower concurrency:

```bash
# Use fewer workers, longer delay
python county_batch_scraper.py --workers 10 --delay 2.0

# This will take 2-4 hours but won't need proxies
```

## Cost Estimates

| Provider | Cost for Full US Scrape | Time |
|----------|------------------------|------|
| BrightData | $50-100 | 15 min |
| Oxylabs | $30-60 | 20 min |
| Smartproxy | $20-40 | 25 min |
| PacketStream | $10-20 | 30 min |
| Webshare (free) | $0 | 2-3 hours |
| No proxies | $0 | 3-4 hours |

## Quick Commands Reference

```bash
# Test proxies
python proxy_manager.py --test-proxies proxies.txt --output working.txt

# Scrape with proxies (fast)
python county_batch_scraper.py --workers 100 --proxies working.txt

# Scrape without proxies (slower)
python county_batch_scraper.py --workers 20

# Monitor progress
python monitoring_dashboard.py --watch --data-dir data/scraped_counties
```
