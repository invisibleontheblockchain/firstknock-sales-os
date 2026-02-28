"""
Quick Start Guide: 2-Hour Nationwide Property Scraping
======================================================
This script provides the fastest path to scraping all US properties.

TARGET: Complete in 2 hours or less
STRATEGY: County-based scraping with 100+ concurrent workers

Why counties instead of ZIPs?
- 3,200 counties vs 42,000 ZIP codes = 13x fewer requests
- Redfin's county API returns ALL properties in one request
- Much higher data density per request

Expected Performance:
- With 100 workers: 10-30 minutes
- With 50 workers: 20-60 minutes  
- With 20 workers (no proxies): 2-3 hours
"""

import subprocess
import sys
import argparse
from pathlib import Path


def install_dependencies():
    """Install required packages."""
    print("Installing dependencies...")
    subprocess.check_call([sys.executable, "-m", "pip", "install", "-r", "requirements.txt"])
    print("✓ Dependencies installed")


def setup_proxies():
    """Guide for proxy setup."""
    print("""
╔══════════════════════════════════════════════════════════════════╗
║                    PROXY SETUP (Recommended)                     ║
╠══════════════════════════════════════════════════════════════════╣
║ For 2-hour completion, you need proxies to avoid rate limits.    ║
║                                                                  ║
║ Recommended proxy providers:                                     ║
║   - BrightData (formerly Luminati) - Residential proxies        ║
║   - Oxylabs - Datacenter & Residential                          ║
║   - Smartproxy - Rotating residential                           ║
║   - PacketStream - P2P residential                              ║
║                                                                  ║
║ Proxy format in proxies.txt:                                     ║
║   http://username:password@ip:port                              ║
║   http://ip:port                                                 ║
║                                                                  ║
║ Recommended: 50-100 proxies for 100 workers                     ║
╚══════════════════════════════════════════════════════════════════╝
""")


def run_county_scraper(workers: int = 100, proxies: str = None):
    """Run the optimized county scraper."""
    print(f"\n{'='*60}")
    print(f"Starting County-Based High-Speed Scraper")
    print(f"{'='*60}")
    print(f"Workers: {workers}")
    print(f"Target: ~3,200 counties")
    print(f"Estimated time: {(3200 / workers * 0.5 / 60):.1f} - {(3200 / workers * 2 / 60):.1f} hours")
    print(f"{'='*60}\n")
    
    cmd = [
        sys.executable,
        "county_batch_scraper.py",
        "--workers", str(workers),
        "--delay", "0.2" if proxies else "1.0"
    ]
    
    if proxies:
        cmd.extend(["--proxies", proxies])
    
    subprocess.call(cmd)


def run_monitoring():
    """Start monitoring dashboard."""
    print("\nStarting monitoring dashboard...")
    subprocess.Popen([
        sys.executable,
        "monitoring_dashboard.py",
        "--watch",
        "--data-dir", "data/scraped_counties"
    ])


def show_post_scrape_instructions():
    """Show instructions after scraping."""
    print("""
╔══════════════════════════════════════════════════════════════════╗
║                    NEXT STEPS                                    ║
╠══════════════════════════════════════════════════════════════════╣
║ 1. Insert into database:                                         ║
║    python insert_to_database.py --input data/scraped_counties   ║
║                                                                  ║
║ 2. Check results:                                                ║
║    python monitoring_dashboard.py --report                       ║
║                                                                  ║
║ 3. Retry failed counties:                                        ║
║    python county_batch_scraper.py --resume --workers 50         ║
╚══════════════════════════════════════════════════════════════════╝
""")


def main():
    parser = argparse.ArgumentParser(
        description='Quick start for 2-hour nationwide scraping',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog='''
Examples:
  # Full setup with proxies (recommended for 2-hour target)
  python quick_start_2hour.py --setup --proxies my_proxies.txt --workers 100
  
  # Without proxies (slower, ~3-4 hours)
  python quick_start_2hour.py --setup --workers 20
  
  # Just run scraper (if already set up)
  python quick_start_2hour.py --scrape --proxies proxies.txt --workers 100
  
  # Specific state only (much faster)
  python quick_start_2hour.py --scrape --state CA --workers 50
        '''
    )
    
    parser.add_argument('--setup', action='store_true',
                        help='Run full setup (install deps, show proxy guide)')
    parser.add_argument('--scrape', action='store_true',
                        help='Run the scraper')
    parser.add_argument('--proxies', help='Path to proxy file')
    parser.add_argument('--workers', type=int, default=100,
                        help='Number of workers (default: 100)')
    parser.add_argument('--state', help='Scrape specific state only')
    parser.add_argument('--monitor', action='store_true',
                        help='Start monitoring dashboard')
    
    args = parser.parse_args()
    
    if args.setup:
        install_dependencies()
        setup_proxies()
        print("\n✓ Setup complete!")
        print("Now get your proxies and run:")
        print(f"  python quick_start_2hour.py --scrape --proxies YOUR_PROXIES.txt --workers {args.workers}")
        return
    
    if args.scrape:
        if args.monitor:
            run_monitoring()
        
        if args.state:
            # Use county scraper with state filter
            cmd = [
                sys.executable,
                "county_batch_scraper.py",
                "--workers", str(args.workers),
                "--state", args.state
            ]
            if args.proxies:
                cmd.extend(["--proxies", args.proxies])
            subprocess.call(cmd)
        else:
            run_county_scraper(args.workers, args.proxies)
        
        show_post_scrape_instructions()
    
    if not args.setup and not args.scrape:
        parser.print_help()
        print("\n" + "="*60)
        print("QUICK START GUIDE")
        print("="*60)
        print("""
To achieve 2-hour nationwide scraping:

1. Get residential proxies (50-100 recommended):
   - BrightData, Oxylabs, Smartproxy, etc.
   - Save to proxies.txt

2. Run full setup:
   python quick_start_2hour.py --setup --proxies proxies.txt --workers 100

3. The scraper will:
   - Fetch 3,200 US counties from Census Bureau
   - Scrape each county with 100 concurrent workers
   - Save properties to data/scraped_counties/
   - Complete in 10-30 minutes with good proxies

4. Insert into database:
   python insert_to_database.py --input data/scraped_counties

Without proxies, expect 3-4 hours with 20 workers.
        """)


if __name__ == '__main__':
    main()
