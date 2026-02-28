"""
No-Proxy High-Speed Scraper
===========================
Optimized for scraping WITHOUT proxies.
Uses smart rate limiting, session rotation, and chunked processing.

Timeline:
- 3,200 counties
- With smart delays: ~2-3 hours
- Can run overnight

Strategies to avoid blocking without proxies:
1. Adaptive rate limiting (slows down if detects issues)
2. Session rotation (resets session every N requests)
3. User-agent rotation
4. Random delays between requests
5. Chunked processing (save progress frequently)
6. Respectful crawling (back off on errors)
"""

import asyncio
import aiohttp
import aiofiles
import json
import csv
import random
import time
import argparse
from datetime import datetime
from pathlib import Path
from typing import List, Dict, Optional, Set, Tuple
from dataclasses import dataclass
import ssl
import logging

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(message)s'
)
logger = logging.getLogger(__name__)


@dataclass
class County:
    name: str
    state: str
    fips: Optional[str] = None


class NoProxyScraper:
    """Scraper optimized for no-proxy operation."""
    
    def __init__(
        self,
        workers: int = 15,
        output_dir: str = "data/scraped_no_proxy",
        session_reset: int = 50  # Reset session every N requests
    ):
        self.workers = workers
        self.output_dir = Path(output_dir)
        self.output_dir.mkdir(parents=True, exist_ok=True)
        self.session_reset = session_reset
        
        # Adaptive rate limiting
        self.min_delay = 1.0  # Start with 1 second
        self.current_delay = 1.0
        self.max_delay = 5.0
        self.success_streak = 0
        self.error_streak = 0
        
        # Statistics
        self.stats = {
            'counties_attempted': 0,
            'counties_success': 0,
            'counties_failed': 0,
            'total_properties': 0,
            'requests_made': 0,
            'errors': 0,
            'start_time': None,
            'end_time': None
        }
        
        # Progress tracking
        self.progress_file = self.output_dir / "progress.json"
        self.completed_counties: Set[str] = set()
        self.failed_counties: List[Dict] = []
        self.lock = asyncio.Lock()
        
        self._load_progress()
    
    def _load_progress(self):
        """Load previous progress."""
        if self.progress_file.exists():
            with open(self.progress_file, 'r') as f:
                data = json.load(f)
                self.completed_counties = set(data.get('completed', []))
                self.failed_counties = data.get('failed', [])
                logger.info(f"Resumed: {len(self.completed_counties)} counties already done")
    
    async def _save_progress(self):
        """Save progress."""
        async with self.lock:
            with open(self.progress_file, 'w') as f:
                json.dump({
                    'completed': list(self.completed_counties),
                    'failed': self.failed_counties,
                    'stats': self.stats,
                    'updated_at': datetime.now().isoformat()
                }, f, indent=2)
    
    def _get_headers(self) -> Dict[str, str]:
        """Rotate user agents."""
        user_agents = [
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.0',
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.0',
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.1',
            'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.0'
        ]
        
        return {
            'User-Agent': random.choice(user_agents),
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept-Encoding': 'gzip, deflate',
            'DNT': '1',
            'Connection': 'keep-alive',
            'Upgrade-Insecure-Requests': '1',
            'Cache-Control': 'max-age=0',
            'Referer': 'https://www.redfin.com/',
        }
    
    async def _adaptive_delay(self):
        """Adaptive delay based on success/error rate."""
        # Add some randomness
        jitter = random.uniform(0.8, 1.2)
        delay = self.current_delay * jitter
        await asyncio.sleep(delay)
    
    def _adjust_delay(self, success: bool):
        """Adjust delay based on response."""
        if success:
            self.success_streak += 1
            self.error_streak = 0
            # Gradually decrease delay on success
            if self.success_streak >= 5:
                self.current_delay = max(self.current_delay * 0.95, self.min_delay)
                self.success_streak = 0
        else:
            self.error_streak += 1
            self.success_streak = 0
            # Increase delay on error
            if self.error_streak >= 2:
                self.current_delay = min(self.current_delay * 1.5, self.max_delay)
                logger.warning(f"Increasing delay to {self.current_delay:.2f}s due to errors")
                self.error_streak = 0
    
    def generate_counties(self) -> List[County]:
        """Generate US counties from Census data."""
        import requests
        import re
        
        logger.info("Fetching county list from Census Bureau...")
        url = "https://www2.census.gov/geo/docs/reference/codes/files/national_county.txt"
        
        try:
            response = requests.get(url, timeout=60)
            response.raise_for_status()
        except Exception as e:
            logger.error(f"Failed to fetch counties: {e}")
            return []
        
        counties = []
        for line in response.text.strip().split('\n'):
            parts = line.split(',')
            if len(parts) >= 4:
                state = parts[0].strip()
                county_name = re.sub(
                    r'\s+(County|Parish|Borough|Census Area|Municipality|City and Borough|City)$',
                    '',
                    parts[3].strip(),
                    flags=re.IGNORECASE
                )
                counties.append(County(name=county_name, state=state, fips=parts[1] + parts[2]))
        
        logger.info(f"Loaded {len(counties)} counties")
        return counties
    
    async def search_county(self, session: aiohttp.ClientSession, county: County) -> Optional[Dict]:
        """Search for county region ID."""
        url = "https://www.redfin.com/stingray/do/location-autocomplete"
        queries = [
            f"{county.name} County, {county.state}",
            f"{county.name}, {county.state}",
        ]
        
        ssl_context = ssl.create_default_context()
        ssl_context.check_hostname = False
        ssl_context.verify_mode = ssl.CERT_NONE
        
        for query in queries:
            try:
                await self._adaptive_delay()
                
                async with session.get(
                    url,
                    params={'location': query, 'v': '2'},
                    headers=self._get_headers(),
                    ssl=ssl_context,
                    timeout=aiohttp.ClientTimeout(total=20)
                ) as response:
                    self.stats['requests_made'] += 1
                    
                    if response.status == 200:
                        text = await response.text()
                        if text.startswith('{}&&'):
                            text = text[4:]
                        
                        data = json.loads(text)
                        sections = data.get('payload', {}).get('sections', [])
                        
                        all_rows = []
                        for section in sections:
                            all_rows.extend(section.get('rows', []))
                        
                        for row in all_rows:
                            if row.get('type') in [5, 2]:
                                full_id = row.get('id', '')
                                parts = full_id.split('_')
                                return {
                                    'id': parts[-1],
                                    'type': parts[0] if len(parts) > 1 else '5',
                                    'name': row.get('name', '')
                                }
                        
                        self._adjust_delay(True)
                        
            except Exception as e:
                self._adjust_delay(False)
                logger.debug(f"Search error for {county.name}, {county.state}: {e}")
        
        return None
    
    async def fetch_properties(self, session: aiohttp.ClientSession, region_id: str, region_type: str, days: int = 1825) -> List[Dict]:
        """Fetch properties for a region."""
        url = "https://www.redfin.com/stingray/api/gis-csv"
        params = {
            'al': 1,
            'region_id': region_id,
            'region_type': region_type,
            'sold_within_days': days,
            'status': '9',
            'v': 8
        }
        
        ssl_context = ssl.create_default_context()
        ssl_context.check_hostname = False
        ssl_context.verify_mode = ssl.CERT_NONE
        
        try:
            await self._adaptive_delay()
            
            async with session.get(
                url,
                params=params,
                headers=self._get_headers(),
                ssl=ssl_context,
                timeout=aiohttp.ClientTimeout(total=120)
            ) as response:
                self.stats['requests_made'] += 1
                
                if response.status == 200:
                    text = await response.text()
                    if len(text) < 100:
                        self._adjust_delay(True)
                        return []
                    
                    lines = text.splitlines()
                    if not lines:
                        return []
                    
                    reader = csv.DictReader(lines)
                    properties = [dict(row) for row in reader]
                    self._adjust_delay(True)
                    return properties
                else:
                    self._adjust_delay(False)
                    return []
                    
        except Exception as e:
            self._adjust_delay(False)
            logger.debug(f"Fetch error: {e}")
            return []
    
    async def scrape_county(self, county: County, days: int = 1825, session: aiohttp.ClientSession = None) -> Tuple[List[Dict], str]:
        """Scrape a county."""
        county_key = f"{county.name}_{county.state}"
        
        if county_key in self.completed_counties:
            return [], 'already_completed'
        
        async with self.lock:
            self.stats['counties_attempted'] += 1
        
        close_session = False
        if session is None:
            connector = aiohttp.TCPConnector(limit=10, limit_per_host=5)
            session = aiohttp.ClientSession(connector=connector)
            close_session = True
        
        try:
            region = await self.search_county(session, county)
            
            if not region:
                async with self.lock:
                    self.failed_counties.append({'county': county.name, 'state': county.state, 'error': 'region_not_found'})
                    self.stats['counties_failed'] += 1
                return [], 'region_not_found'
            
            properties = await self.fetch_properties(session, region['id'], region['type'], days)
            
            if properties:
                for prop in properties:
                    prop['_source_county'] = county.name
                    prop['_source_state'] = county.state
                    prop['_scraped_at'] = datetime.now().isoformat()
                
                async with self.lock:
                    self.completed_counties.add(county_key)
                    self.stats['counties_success'] += 1
                    self.stats['total_properties'] += len(properties)
                
                return properties, 'success'
            else:
                async with self.lock:
                    self.failed_counties.append({'county': county.name, 'state': county.state, 'error': 'no_properties'})
                    self.stats['counties_failed'] += 1
                return [], 'no_properties'
                
        finally:
            if close_session:
                await session.close()
    
    async def save_properties(self, county: County, properties: List[Dict]):
        """Save properties to disk."""
        if not properties:
            return
        
        # JSON file
        json_file = self.output_dir / "by_county" / f"{county.state.lower()}_{county.name.lower().replace(' ', '_')}.json"
        json_file.parent.mkdir(parents=True, exist_ok=True)
        
        async with aiofiles.open(json_file, 'w') as f:
            await f.write(json.dumps(properties, indent=2))
        
        # CSV file
        csv_file = self.output_dir / f"properties_{county.state.lower()}.csv"
        file_exists = csv_file.exists()
        
        async with aiofiles.open(csv_file, 'a', newline='') as f:
            if not file_exists and properties:
                header = ','.join(f'"{k}"' for k in properties[0].keys()) + '\n'
                await f.write(header)
            
            for prop in properties:
                row = ','.join(f'"{str(v).replace(chr(34), chr(34)+chr(34))}"' for v in prop.values()) + '\n'
                await f.write(row)
    
    async def chunked_worker(self, counties: List[County], days: int, worker_id: int):
        """Worker that processes counties with session reset."""
        ssl_context = ssl.create_default_context()
        ssl_context.check_hostname = False
        ssl_context.verify_mode = ssl.CERT_NONE
        
        connector = aiohttp.TCPConnector(limit=10, limit_per_host=5)
        
        async with aiohttp.ClientSession(connector=connector) as session:
            for i, county in enumerate(counties):
                # Reset session periodically
                if i > 0 and i % self.session_reset == 0:
                    await session.close()
                    connector = aiohttp.TCPConnector(limit=10, limit_per_host=5)
                    session = aiohttp.ClientSession(connector=connector)
                    logger.debug(f"Worker {worker_id}: Reset session after {i} counties")
                
                properties, status = await self.scrape_county(county, days, session)
                
                if properties:
                    await self.save_properties(county, properties)
                    logger.info(f"Worker {worker_id}: ✓ {county.name}, {county.state} - {len(properties)} properties")
                elif status != 'already_completed':
                    logger.info(f"Worker {worker_id}: ✗ {county.name}, {county.state} - {status}")
    
    async def run(self, counties: List[County], days: int = 1825):
        """Run the scraper."""
        self.stats['start_time'] = time.time()
        
        # Filter completed
        pending = [c for c in counties if f"{c.name}_{c.state}" not in self.completed_counties]
        
        print("="*60)
        print("NO-PROXY PROPERTY SCRAPER")
        print("="*60)
        print(f"Total counties: {len(counties)}")
        print(f"Already completed: {len(counties) - len(pending)}")
        print(f"Pending: {len(pending)}")
        print(f"Workers: {self.workers}")
        print(f"Estimated time: {(len(pending) * 2 / self.workers / 3600):.1f} - {(len(pending) * 4 / self.workers / 3600):.1f} hours")
        print("="*60)
        print("\nStarting scrape (this will take a few hours)...")
        print("Press Ctrl+C to pause (you can resume later)")
        print("="*60 + "\n")
        
        if not pending:
            print("All counties already completed!")
            return
        
        # Split counties among workers
        chunk_size = len(pending) // self.workers + 1
        chunks = [pending[i:i+chunk_size] for i in range(0, len(pending), chunk_size)]
        
        # Run workers
        tasks = [
            self.chunked_worker(chunk, days, i)
            for i, chunk in enumerate(chunks[:self.workers])
        ]
        
        # Progress reporter
        async def report_progress():
            last_count = 0
            while True:
                await asyncio.sleep(30)  # Report every 30 seconds
                current = len(self.completed_counties)
                if current > last_count:
                    elapsed = time.time() - self.stats['start_time']
                    rate = (current - (len(counties) - len(pending))) / elapsed if elapsed > 0 else 0
                    remaining = (len(pending) - (current - (len(counties) - len(pending)))) / rate if rate > 0 else 0
                    
                    logger.info(
                        f"PROGRESS: {current}/{len(counties)} counties | "
                        f"Properties: {self.stats['total_properties']:,} | "
                        f"Rate: {rate*3600:.0f} counties/hour | "
                        f"ETA: {remaining/3600:.1f}h | "
                        f"Delay: {self.current_delay:.2f}s"
                    )
                    await self._save_progress()
                    last_count = current
        
        # Run everything
        reporter = asyncio.create_task(report_progress())
        
        try:
            await asyncio.gather(*tasks)
        except KeyboardInterrupt:
            logger.info("\n\nScraping paused by user. Progress saved.")
            logger.info("Resume anytime with: python no_proxy_scraper.py")
        finally:
            reporter.cancel()
            await self._save_progress()
        
        self.stats['end_time'] = time.time()
        await self._save_progress()
        self._print_stats()
    
    def _print_stats(self):
        """Print final statistics."""
        elapsed = self.stats['end_time'] - self.stats['start_time']
        
        print("\n" + "="*60)
        print("FINAL STATISTICS")
        print("="*60)
        print(f"Elapsed time: {elapsed/3600:.2f} hours")
        print(f"Counties completed: {self.stats['counties_success']}/{self.stats['counties_attempted']}")
        print(f"Total properties: {self.stats['total_properties']:,}")
        print(f"Total requests: {self.stats['requests_made']}")
        print(f"Average rate: {self.stats['counties_success']/(elapsed/3600):.0f} counties/hour")
        print(f"\nData saved to: {self.output_dir}")
        print("\nNext step - insert into database:")
        print(f"  python insert_to_database.py --input {self.output_dir}")
        print("="*60)


def main():
    parser = argparse.ArgumentParser(
        description='No-proxy property scraper (2-3 hours for full US)',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog='''
Examples:
  # Basic usage (15 workers, ~2-3 hours)
  python no_proxy_scraper.py
  
  # Faster with more workers (may risk blocks)
  python no_proxy_scraper.py --workers 20
  
  # Slower but safer
  python no_proxy_scraper.py --workers 10
  
  # Specific state only (much faster)
  python no_proxy_scraper.py --state TX
        '''
    )
    
    parser.add_argument('--workers', type=int, default=15,
                        help='Number of workers (default: 15, max recommended: 20)')
    parser.add_argument('--output-dir', default='data/scraped_no_proxy',
                        help='Output directory')
    parser.add_argument('--state', help='Scrape specific state only')
    parser.add_argument('--resume', action='store_true',
                        help='Resume from previous run')
    
    args = parser.parse_args()
    
    scraper = NoProxyScraper(
        workers=args.workers,
        output_dir=args.output_dir
    )
    
    # Get counties
    counties = scraper.generate_counties()
    
    if args.state:
        counties = [c for c in counties if c.state.upper() == args.state.upper()]
        print(f"Filtered to {len(counties)} counties in {args.state}")
    
    if not counties:
        print("No counties to scrape!")
        return
    
    # Run
    asyncio.run(scraper.run(counties))


if __name__ == '__main__':
    main()
