"""
Proxy Management Utility for High-Speed Scraping
================================================
Manages proxy lists, tests proxies, and rotates them for scraping.

Usage:
    # Test proxy list
    python proxy_manager.py --test-proxies proxies.txt --output working_proxies.txt
    
    # Generate proxy list from free sources (not recommended for production)
    python proxy_manager.py --fetch-free --output free_proxies.txt
    
    # Check proxy health
    python proxy_manager.py --health-check working_proxies.txt
"""

import asyncio
import aiohttp
import argparse
import random
from pathlib import Path
from typing import List, Dict, Tuple, Optional
from dataclasses import dataclass
from datetime import datetime
import ssl


@dataclass
class Proxy:
    """Represents a proxy server."""
    host: str
    port: int
    protocol: str = 'http'
    username: Optional[str] = None
    password: Optional[str] = None
    country: Optional[str] = None
    response_time: float = 0.0
    is_working: bool = False
    last_tested: Optional[str] = None
    
    @property
    def url(self) -> str:
        """Get full proxy URL."""
        if self.username and self.password:
            return f"{self.protocol}://{self.username}:{self.password}@{self.host}:{self.port}"
        return f"{self.protocol}://{self.host}:{self.port}"
    
    def __str__(self) -> str:
        return f"{self.host}:{self.port}"


class ProxyManager:
    """Manages proxy lists and testing."""
    
    TEST_URLS = [
        "https://www.redfin.com",
        "https://httpbin.org/ip",
        "https://api.ipify.org?format=json"
    ]
    
    def __init__(self, timeout: int = 10):
        self.timeout = aiohttp.ClientTimeout(total=timeout)
        self.ssl_context = ssl.create_default_context()
        self.ssl_context.check_hostname = False
        self.ssl_context.verify_mode = ssl.CERT_NONE
    
    def parse_proxy_line(self, line: str) -> Optional[Proxy]:
        """Parse a proxy from a line (format: ip:port or protocol://ip:port)."""
        line = line.strip()
        if not line or line.startswith('#'):
            return None
        
        try:
            # Handle protocol:// format
            if '://' in line:
                protocol, rest = line.split('://', 1)
                
                # Handle auth
                if '@' in rest:
                    auth, host_port = rest.split('@', 1)
                    username, password = auth.split(':', 1)
                else:
                    username = password = None
                    host_port = rest
                
                host, port = host_port.rsplit(':', 1)
                return Proxy(
                    host=host,
                    port=int(port),
                    protocol=protocol,
                    username=username,
                    password=password
                )
            else:
                # Simple ip:port format
                host, port = line.rsplit(':', 1)
                return Proxy(host=host, port=int(port))
                
        except Exception as e:
            print(f"Failed to parse proxy: {line} - {e}")
            return None
    
    def load_proxies(self, filepath: str) -> List[Proxy]:
        """Load proxies from file."""
        path = Path(filepath)
        if not path.exists():
            print(f"Proxy file not found: {filepath}")
            return []
        
        proxies = []
        with open(path, 'r') as f:
            for line in f:
                proxy = self.parse_proxy_line(line)
                if proxy:
                    proxies.append(proxy)
        
        print(f"Loaded {len(proxies)} proxies from {filepath}")
        return proxies
    
    async def test_proxy(self, proxy: Proxy, test_url: str = None) -> Tuple[bool, float]:
        """Test if a proxy is working."""
        test_url = test_url or self.TEST_URLS[1]  # Use httpbin by default
        
        headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
        
        start_time = asyncio.get_event_loop().time()
        
        try:
            async with aiohttp.ClientSession(timeout=self.timeout) as session:
                async with session.get(
                    test_url,
                    proxy=proxy.url,
                    headers=headers,
                    ssl=self.ssl_context
                ) as response:
                    elapsed = asyncio.get_event_loop().time() - start_time
                    
                    if response.status == 200:
                        proxy.response_time = elapsed
                        proxy.is_working = True
                        proxy.last_tested = datetime.now().isoformat()
                        return True, elapsed
                    else:
                        return False, elapsed
                        
        except Exception as e:
            elapsed = asyncio.get_event_loop().time() - start_time
            return False, elapsed
    
    async def test_proxies(
        self,
        proxies: List[Proxy],
        max_concurrent: int = 50,
        test_url: str = None
    ) -> List[Proxy]:
        """Test multiple proxies concurrently."""
        semaphore = asyncio.Semaphore(max_concurrent)
        
        async def test_with_limit(proxy: Proxy) -> Proxy:
            async with semaphore:
                is_working, response_time = await self.test_proxy(proxy, test_url)
                proxy.is_working = is_working
                proxy.response_time = response_time
                proxy.last_tested = datetime.now().isoformat()
                return proxy
        
        print(f"Testing {len(proxies)} proxies with {max_concurrent} concurrent tests...")
        
        tasks = [test_with_limit(proxy) for proxy in proxies]
        results = await asyncio.gather(*tasks, return_exceptions=True)
        
        working = []
        failed = 0
        
        for result in results:
            if isinstance(result, Exception):
                failed += 1
            elif result.is_working:
                working.append(result)
            else:
                failed += 1
        
        print(f"\nResults:")
        print(f"  Working: {len(working)}")
        print(f"  Failed: {failed}")
        
        # Sort by response time
        working.sort(key=lambda p: p.response_time)
        
        return working
    
    def save_proxies(self, proxies: List[Proxy], filepath: str):
        """Save proxies to file."""
        with open(filepath, 'w') as f:
            f.write(f"# Generated: {datetime.now().isoformat()}\n")
            f.write(f"# Working proxies: {len(proxies)}\n\n")
            for proxy in proxies:
                f.write(f"{proxy.url}\n")
        
        print(f"Saved {len(proxies)} proxies to {filepath}")
    
    async def fetch_free_proxies(self) -> List[Proxy]:
        """
        Fetch free proxies from public sources.
        WARNING: Free proxies are unreliable and slow. Use for testing only.
        """
        print("Fetching free proxies from public sources...")
        print("WARNING: Free proxies are unreliable. Use residential/datacenter proxies for production.")
        
        proxies = []
        
        # Source 1: ProxyList
        try:
            url = "https://api.proxyscrape.com/v2/?request=displayproxies&protocol=http&timeout=10000&country=all&ssl=all&anonymity=all"
            async with aiohttp.ClientSession() as session:
                async with session.get(url, timeout=aiohttp.ClientTimeout(total=30)) as response:
                    if response.status == 200:
                        text = await response.text()
                        for line in text.strip().split('\n'):
                            if ':' in line:
                                proxy = self.parse_proxy_line(line.strip())
                                if proxy:
                                    proxies.append(proxy)
            print(f"  Fetched {len(proxies)} from ProxyScrape")
        except Exception as e:
            print(f"  Failed to fetch from ProxyScrape: {e}")
        
        return proxies
    
    def generate_proxy_stats(self, proxies: List[Proxy]) -> Dict:
        """Generate statistics about proxies."""
        working = [p for p in proxies if p.is_working]
        
        if not working:
            return {'count': 0, 'avg_response': 0}
        
        avg_response = sum(p.response_time for p in working) / len(working)
        
        return {
            'total': len(proxies),
            'working': len(working),
            'failed': len(proxies) - len(working),
            'avg_response_time': round(avg_response, 2),
            'fastest': round(min(p.response_time for p in working), 2),
            'slowest': round(max(p.response_time for p in working), 2)
        }


def main():
    parser = argparse.ArgumentParser(
        description='Proxy management utility',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog='''
Examples:
  # Test proxy file and save working ones
  python proxy_manager.py --test-proxies my_proxies.txt --output working.txt
  
  # Test with Redfin (more accurate)
  python proxy_manager.py --test-proxies proxies.txt --test-url https://www.redfin.com
  
  # Fetch free proxies (testing only)
  python proxy_manager.py --fetch-free --output free_proxies.txt
  
  # Full pipeline: fetch, test, save
  python proxy_manager.py --fetch-free --test --output working_proxies.txt
        '''
    )
    
    parser.add_argument('--test-proxies', help='Proxy file to test')
    parser.add_argument('--output', '-o', help='Output file for working proxies')
    parser.add_argument('--fetch-free', action='store_true',
                        help='Fetch free proxies (unreliable, for testing only)')
    parser.add_argument('--test', action='store_true',
                        help='Test proxies after fetching')
    parser.add_argument('--test-url', default='https://httpbin.org/ip',
                        help='URL to test proxies against')
    parser.add_argument('--max-concurrent', type=int, default=50,
                        help='Max concurrent proxy tests')
    
    args = parser.parse_args()
    
    manager = ProxyManager()
    
    if args.fetch_free:
        proxies = asyncio.run(manager.fetch_free_proxies())
        
        if args.test and proxies:
            proxies = asyncio.run(manager.test_proxies(
                proxies,
                max_concurrent=args.max_concurrent,
                test_url=args.test_url
            ))
        
        if args.output:
            manager.save_proxies(proxies, args.output)
    
    elif args.test_proxies:
        proxies = manager.load_proxies(args.test_proxies)
        
        if proxies:
            working = asyncio.run(manager.test_proxies(
                proxies,
                max_concurrent=args.max_concurrent,
                test_url=args.test_url
            ))
            
            # Print stats
            stats = manager.generate_proxy_stats(working)
            print(f"\nProxy Statistics:")
            for key, value in stats.items():
                print(f"  {key}: {value}")
            
            if args.output:
                manager.save_proxies(working, args.output)
    
    else:
        parser.print_help()


if __name__ == '__main__':
    main()
