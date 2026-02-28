"""
High-Speed Nationwide Property Scraper
======================================
Optimized for 2-hour completion of all US ZIP codes.
Uses async/concurrent requests with proxy rotation.

Key optimizations:
- Async/await with aiohttp (1000+ concurrent connections)
- Proxy rotation to avoid rate limits
- Connection pooling
- Batch processing
- Minimal delays with proxies (0.1-0.3s)

Usage:
    python high_speed_scraper.py --workers 100 --proxies proxies.txt
    python high_speed_scraper.py --mode state --state CA --workers 50
"""

import asyncio
import aiohttp
import aiofiles
import json
import csv
import random
import time
import argparse
import logging
from datetime import datetime
from pathlib import Path
from typing import List, Dict, Optional, Set, Tuple
from dataclasses import dataclass, asdict
from collections import deque
import ssl

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)


@dataclass
class ScrapingProgress:
    """Track scraping progress."""
    total_zips: int = 0
    completed_zips: int = 0
    failed_zips: int = 0
    total_properties: int = 0
    start_time: Optional[str] = None
    
    def to_dict(self):
        return asdict(self)


class ProxyRotator:
    """Manages proxy rotation for distributed requests."""
    
    def __init__(self, proxy_file: Optional[str] = None):
        self.proxies: List[str] = []
        self.current_index = 0
        self.failed_proxies: Set[str] = set()
        
        if proxy_file and Path(proxy_file).exists():
            self.load_proxies(proxy_file)
        else:
            # Default: direct connection (no proxy)
            self.proxies = [None]
    
    def load_proxies(self, filepath: str):
        """Load proxies from file (format: ip:port or http://ip:port)."""
        with open(filepath, 'r') as f:
            lines = [line.strip() for line in f if line.strip()]
        
        self.proxies = []
        for line in lines:
            if not line.startswith('http'):
                line = f"http://{line}"
            self.proxies.append(line)
        
        logger.info(f"Loaded {len(self.proxies)} proxies")
    
    def get_proxy(self) -> Optional[str]:
        """Get next proxy in rotation."""
        if not self.proxies or len(self.proxies) == 1:
            return self.proxies[0] if self.proxies else None
        
        # Skip failed proxies
        attempts = 0
        while attempts < len(self.proxies):
            proxy = self.proxies[self.current_index % len(self.proxies)]
            self.current_index += 1
            if proxy not in self.failed_proxies:
                return proxy
            attempts += 1
        
        return None
    
    def mark_failed(self, proxy: str):
        """Mark a proxy as failed."""
        self.failed_proxies.add(proxy)
        logger.warning(f"Proxy failed: {proxy}")


class HighSpeedScraper:
    """High-speed async property scraper."""
    
    def __init__(
        self,
        proxy_file: Optional[str] = None,
        workers: int = 100,
        delay: float = 0.1,
        output_dir: str = "data/scraped_fast",
        session_timeout: int = 30
    ):
        self.workers = workers
        self.delay = delay
        self.output_dir = Path(output_dir)
        self.output_dir.mkdir(parents=True, exist_ok=True)
        
        self.proxy_rotator = ProxyRotator(proxy_file)
        self.use_proxies = len(self.proxy_rotator.proxies) > 1
        
        # SSL context that doesn't verify certificates (for proxies)
        self.ssl_context = ssl.create_default_context()
        self.ssl_context.check_hostname = False
        self.ssl_context.verify_mode = ssl.CERT_NONE
        
        # Session timeout
        self.timeout = aiohttp.ClientTimeout(total=session_timeout)
        
        # Statistics
        self.stats = {
            'zips_attempted': 0,
            'zips_success': 0,
            'zips_failed': 0,
            'total_properties': 0,
            'requests_made': 0,
            'rate_limited': 0,
            'start_time': None,
            'end_time': None
        }
        
        # Progress tracking
        self.progress_file = self.output_dir / "fast_progress.json"
        self.completed_zips: Set[str] = set()
        self.failed_zips: List[Dict] = []
        self.lock = asyncio.Lock()
        
        # Rate limiting
        self.request_times: deque = deque(maxlen=1000)
        self.min_delay = delay
        self.adaptive_delay = delay
        
        # Load previous progress
        self._load_progress()
    
    def _load_progress(self):
        """Load previous scraping progress."""
        if self.progress_file.exists():
            with open(self.progress_file, 'r') as f:
                data = json.load(f)
                self.completed_zips = set(data.get('completed_zips', []))
                self.failed_zips = data.get('failed_zips', [])
                logger.info(f"Loaded progress: {len(self.completed_zips)} completed, {len(self.failed_zips)} failed")
    
    async def _save_progress(self):
        """Save scraping progress."""
        async with self.lock:
            with open(self.progress_file, 'w') as f:
                json.dump({
                    'completed_zips': list(self.completed_zips),
                    'failed_zips': self.failed_zips,
                    'stats': self.stats,
                    'updated_at': datetime.now().isoformat()
                }, f, indent=2)
    
    def _get_headers(self) -> Dict[str, str]:
        """Get random headers to avoid detection."""
        user_agents = [
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
            'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15'
        ]
        
        return {
            'User-Agent': random.choice(user_agents),
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept-Encoding': 'gzip, deflate, br',
            'DNT': '1',
            'Connection': 'keep-alive',
            'Upgrade-Insecure-Requests': '1',
            'Sec-Fetch-Dest': 'document',
            'Sec-Fetch-Mode': 'navigate',
            'Cache-Control': 'max-age=0',
            'Referer': 'https://www.redfin.com/',
        }
    
    async def _adaptive_sleep(self):
        """Adaptive delay based on recent response times and errors."""
        await asyncio.sleep(self.adaptive_delay)
    
    async def search_location(self, session: aiohttp.ClientSession, zip_code: str, max_retries: int = 3) -> Optional[Dict]:
        """Search for ZIP code location with retries and proxy rotation."""
        url = "https://www.redfin.com/stingray/do/location-autocomplete"
        params = {'location': zip_code, 'v': '2'}
        
        for attempt in range(max_retries):
            proxy = self.proxy_rotator.get_proxy()
            headers = self._get_headers()
            
            try:
                await self._adaptive_sleep()
                
                start_time = time.time()
                async with session.get(
                    url,
                    params=params,
                    headers=headers,
                    proxy=proxy,
                    ssl=self.ssl_context,
                    timeout=self.timeout
                ) as response:
                    self.request_times.append(time.time() - start_time)
                    self.stats['requests_made'] += 1
                    
                    if response.status == 403:
                        self.stats['rate_limited'] += 1
                        if proxy:
                            self.proxy_rotator.mark_failed(proxy)
                        # Increase delay on rate limit
                        self.adaptive_delay = min(self.adaptive_delay * 1.5, 2.0)
                        continue
                    
                    if response.status == 200:
                        text = await response.text()
                        if text.startswith('{}&&'):
                            text = text[4:]
                        
                        data = json.loads(text)
                        sections = data.get('payload', {}).get('sections', [])
                        
                        all_rows = []
                        for section in sections:
                            all_rows.extend(section.get('rows', []))
                        
                        if not all_rows:
                            return None
                        
                        best_match = None
                        for row in all_rows:
                            if zip_code in row.get('name', ''):
                                best_match = row
                                break
                        
                        if not best_match:
                            best_match = all_rows[0]
                        
                        full_id = best_match.get('id', '')
                        parts = full_id.split('_')
                        region_id = parts[-1]
                        region_type = parts[0] if len(parts) > 1 else best_match.get('type', '1')
                        
                        # Decrease delay on success
                        self.adaptive_delay = max(self.adaptive_delay * 0.95, self.min_delay)
                        
                        return {
                            'id': region_id,
                            'type': region_type,
                            'name': best_match.get('name')
                        }
                    
            except asyncio.TimeoutError:
                if proxy:
                    self.proxy_rotator.mark_failed(proxy)
            except Exception as e:
                if proxy and 'proxy' in str(e).lower():
                    self.proxy_rotator.mark_failed(proxy)
                if attempt == max_retries - 1:
                    return None
        
        return None
    
    async def fetch_properties_csv(
        self,
        session: aiohttp.ClientSession,
        region_id: str,
        region_type: str,
        days: int = 1825,
        max_retries: int = 3
    ) -> List[Dict]:
        """Fetch properties CSV with retries."""
        url = "https://www.redfin.com/stingray/api/gis-csv"
        params = {
            'al': 1,
            'region_id': region_id,
            'region_type': region_type,
            'sold_within_days': days,
            'status': '9',
            'v': 8
        }
        
        for attempt in range(max_retries):
            proxy = self.proxy_rotator.get_proxy()
            headers = self._get_headers()
            
            try:
                await self._adaptive_sleep()
                
                async with session.get(
                    url,
                    params=params,
                    headers=headers,
                    proxy=proxy,
                    ssl=self.ssl_context,
                    timeout=aiohttp.ClientTimeout(total=60)
                ) as response:
                    self.stats['requests_made'] += 1
                    
                    if response.status == 403:
                        self.stats['rate_limited'] += 1
                        if proxy:
                            self.proxy_rotator.mark_failed(proxy)
                        continue
                    
                    if response.status == 200:
                        text = await response.text()
                        if len(text) < 100:
                            return []
                        
                        # Parse CSV
                        lines = text.splitlines()
                        if not lines:
                            return []
                        
                        reader = csv.DictReader(lines)
                        properties = [dict(row) for row in reader]
                        
                        # Decrease delay on success
                        self.adaptive_delay = max(self.adaptive_delay * 0.95, self.min_delay)
                        
                        return properties
                    
            except asyncio.TimeoutError:
                if proxy:
                    self.proxy_rotator.mark_failed(proxy)
            except Exception as e:
                if proxy and 'proxy' in str(e).lower():
                    self.proxy_rotator.mark_failed(proxy)
        
        return []
    
    async def scrape_zip(self, session: aiohttp.ClientSession, zip_code: str, days: int = 1825) -> Tuple[List[Dict], str]:
        """Scrape a single ZIP code."""
        # Check if already completed
        if zip_code in self.completed_zips:
            return [], 'already_completed'
        
        async with self.lock:
            self.stats['zips_attempted'] += 1
        
        try:
            # Search for location
            location = await self.search_location(session, zip_code)
            if not location:
                async with self.lock:
                    self.failed_zips.append({'zip': zip_code, 'error': 'location_not_found'})
                    self.stats['zips_failed'] += 1
                return [], 'location_not_found'
            
            # Fetch properties
            properties = await self.fetch_properties_csv(
                session,
                location['id'],
                location['type'],
                days
            )
            
            if properties:
                # Add metadata
                for prop in properties:
                    prop['_source_zip'] = zip_code
                    prop['_scraped_at'] = datetime.now().isoformat()
                
                async with self.lock:
                    self.completed_zips.add(zip_code)
                    self.stats['zips_success'] += 1
                    self.stats['total_properties'] += len(properties)
                
                return properties, 'success'
            else:
                async with self.lock:
                    self.failed_zips.append({'zip': zip_code, 'error': 'no_properties'})
                    self.stats['zips_failed'] += 1
                return [], 'no_properties'
                
        except Exception as e:
            async with self.lock:
                self.failed_zips.append({'zip': zip_code, 'error': str(e)})
                self.stats['zips_failed'] += 1
            return [], str(e)
    
    async def save_properties(self, zip_code: str, properties: List[Dict]):
        """Save properties to disk asynchronously."""
        if not properties:
            return
        
        # Save as JSON
        json_file = self.output_dir / "by_zip" / f"{zip_code}.json"
        json_file.parent.mkdir(parents=True, exist_ok=True)
        
        async with aiofiles.open(json_file, 'w') as f:
            await f.write(json.dumps(properties, indent=2))
        
        # Append to state CSV
        state = properties[0].get('STATE OR PROVINCE', 'UNK')
        csv_file = self.output_dir / f"properties_{state.lower()}.csv"
        
        file_exists = csv_file.exists()
        async with aiofiles.open(csv_file, 'a', newline='') as f:
            if not file_exists and properties:
                header = ','.join(f'"{k}"' for k in properties[0].keys()) + '\n'
                await f.write(header)
            
            for prop in properties:
                row = ','.join(f'"{str(v).replace(chr(34), chr(34)+chr(34))}"' for v in prop.values()) + '\n'
                await f.write(row)
    
    async def worker(self, session: aiohttp.ClientSession, queue: asyncio.Queue, days: int, progress_queue: asyncio.Queue):
        """Worker to process ZIP codes from queue."""
        while True:
            try:
                zip_code = await asyncio.wait_for(queue.get(), timeout=1.0)
            except asyncio.TimeoutError:
                break
            
            if zip_code is None:
                break
            
            properties, status = await self.scrape_zip(session, zip_code, days)
            
            if properties:
                await self.save_properties(zip_code, properties)
            
            queue.task_done()
            await progress_queue.put((zip_code, status, len(properties)))
    
    async def progress_reporter(self, queue: asyncio.Queue, total: int):
        """Report progress periodically."""
        last_report = time.time()
        processed = 0
        
        while True:
            try:
                zip_code, status, count = await asyncio.wait_for(queue.get(), timeout=1.0)
                processed += 1
                
                if time.time() - last_report > 10:  # Report every 10 seconds
                    elapsed = time.time() - self.stats['start_time']
                    rate = processed / elapsed if elapsed > 0 else 0
                    eta_seconds = (total - processed) / rate if rate > 0 else 0
                    
                    logger.info(
                        f"Progress: {processed}/{total} ({processed/total*100:.1f}%) | "
                        f"Rate: {rate*3600:.0f} ZIPs/hour | "
                        f"ETA: {eta_seconds/3600:.1f}h | "
                        f"Success: {self.stats['zips_success']} | "
                        f"Failed: {self.stats['zips_failed']} | "
                        f"Properties: {self.stats['total_properties']}"
                    )
                    
                    # Save progress
                    await self._save_progress()
                    last_report = time.time()
                    
            except asyncio.TimeoutError:
                if processed >= total:
                    break
                continue
    
    async def scrape_zips(self, zip_codes: List[str], days: int = 1825):
        """Scrape multiple ZIP codes concurrently."""
        total = len(zip_codes)
        self.stats['start_time'] = time.time()
        
        logger.info(f"Starting high-speed scrape of {total} ZIP codes with {self.workers} workers")
        logger.info(f"Proxies: {len(self.proxy_rotator.proxies)} (using proxies: {self.use_proxies})")
        logger.info(f"Target: Complete in ~{total / (self.workers * 10 * 3600):.1f} hours at 10 req/worker/sec")
        
        # Filter out already completed
        pending_zips = [z for z in zip_codes if z not in self.completed_zips]
        logger.info(f"Pending ZIP codes: {len(pending_zips)} (already completed: {len(self.completed_zips)})")
        
        if not pending_zips:
            logger.info("All ZIP codes already completed!")
            return
        
        # Create queues
        work_queue = asyncio.Queue(maxsize=self.workers * 2)
        progress_queue = asyncio.Queue()
        
        # Create connector with connection pooling
        connector = aiohttp.TCPConnector(
            limit=self.workers * 2,
            limit_per_host=self.workers,
            ttl_dns_cache=300,
            use_dns_cache=True,
        )
        
        async with aiohttp.ClientSession(connector=connector) as session:
            # Start workers
            worker_tasks = [
                asyncio.create_task(self.worker(session, work_queue, days, progress_queue))
                for _ in range(self.workers)
            ]
            
            # Start progress reporter
            reporter_task = asyncio.create_task(self.progress_reporter(progress_queue, len(pending_zips)))
            
            # Fill work queue
            for zip_code in pending_zips:
                await work_queue.put(zip_code)
            
            # Wait for completion
            await work_queue.join()
            
            # Stop workers
            for _ in range(self.workers):
                await work_queue.put(None)
            
            await asyncio.gather(*worker_tasks, return_exceptions=True)
            await reporter_task
        
        self.stats['end_time'] = time.time()
        await self._save_progress()
        self._print_final_stats()
    
    def _print_final_stats(self):
        """Print final statistics."""
        elapsed = self.stats['end_time'] - self.stats['start_time']
        
        logger.info("="*60)
        logger.info("FINAL STATISTICS")
        logger.info("="*60)
        logger.info(f"Elapsed time: {elapsed/3600:.2f} hours")
        logger.info(f"ZIP codes attempted: {self.stats['zips_attempted']}")
        logger.info(f"ZIP codes successful: {self.stats['zips_success']}")
        logger.info(f"ZIP codes failed: {self.stats['zips_failed']}")
        logger.info(f"Total properties: {self.stats['total_properties']}")
        logger.info(f"Total requests: {self.stats['requests_made']}")
        logger.info(f"Rate limited: {self.stats['rate_limited']}")
        logger.info(f"Average rate: {self.stats['zips_attempted']/(elapsed/3600):.0f} ZIPs/hour")
        
        if self.failed_zips:
            failed_file = self.output_dir / "failed_zips.json"
            with open(failed_file, 'w') as f:
                json.dump(self.failed_zips, f, indent=2)
            logger.info(f"Failed ZIPs saved to: {failed_file}")
    
    def load_zip_codes(self, filepath: str = "data/us_zipcodes.json") -> List[str]:
        """Load ZIP codes from file."""
        path = Path(filepath)
        if not path.exists():
            logger.error(f"ZIP codes file not found: {filepath}")
            return []
        
        with open(path, 'r') as f:
            data = json.load(f)
        
        zips = [z['zip'] for z in data.get('zip_codes', []) if z.get('zip')]
        logger.info(f"Loaded {len(zips)} ZIP codes")
        return zips


def main():
    parser = argparse.ArgumentParser(
        description='High-speed nationwide property scraper',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog='''
Examples:
  # Scrape all ZIPs with 100 workers (requires proxies for best results)
  python high_speed_scraper.py --workers 100 --proxies proxies.txt
  
  # Scrape specific state
  python high_speed_scraper.py --state CA --workers 50
  
  # Scrape without proxies (slower, more rate limits)
  python high_speed_scraper.py --workers 20 --delay 1.0
  
  # Resume interrupted scrape
  python high_speed_scraper.py --resume --workers 100 --proxies proxies.txt
        '''
    )
    
    parser.add_argument('--workers', type=int, default=100,
                        help='Number of concurrent workers (default: 100)')
    parser.add_argument('--proxies', help='Path to proxy list file (ip:port per line)')
    parser.add_argument('--delay', type=float, default=0.1,
                        help='Base delay between requests in seconds (default: 0.1)')
    parser.add_argument('--days', type=int, default=1825,
                        help='Days to look back (default: 1825 = 5 years)')
    parser.add_argument('--output-dir', default='data/scraped_fast',
                        help='Output directory (default: data/scraped_fast)')
    parser.add_argument('--zip-file', default='data/us_zipcodes.json',
                        help='ZIP codes JSON file')
    parser.add_argument('--state', help='Scrape specific state only')
    parser.add_argument('--resume', action='store_true',
                        help='Resume from previous run')
    
    args = parser.parse_args()
    
    # Initialize scraper
    scraper = HighSpeedScraper(
        proxy_file=args.proxies,
        workers=args.workers,
        delay=args.delay,
        output_dir=args.output_dir
    )
    
    # Load ZIP codes
    zip_data = scraper.load_zip_codes(args.zip_file)
    
    if args.state:
        # Filter by state
        import json
        with open(args.zip_file, 'r') as f:
            data = json.load(f)
        zip_data = [
            z['zip'] for z in data.get('zip_codes', [])
            if z.get('state', '').upper() == args.state.upper() and z.get('zip')
        ]
        logger.info(f"Filtered to {len(zip_data)} ZIP codes in {args.state}")
    
    if not zip_data:
        logger.error("No ZIP codes to process!")
        return
    
    # Run scraper
    asyncio.run(scraper.scrape_zips(zip_data, args.days))


if __name__ == '__main__':
    main()
