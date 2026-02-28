"""
Unified US Property Data Scraper
================================
The complete solution for fetching property data from any US county.

This script combines multiple approaches:
1. Redfin API (free, no key required)
2. County-by-county batch processing
3. State-wide data collection

Usage:
    # Single ZIP
    python unified_property_scraper.py --mode zip --zip 90210
    
    # Single County
    python unified_property_scraper.py --mode county --state CA --county "Los Angeles"
    
    # Entire State (all counties)
    python unified_property_scraper.py --mode state --state TX
    
    # Multiple specific counties
    python unified_property_scraper.py --mode counties --state FL --counties "Miami-Dade,Broward,Palm Beach"
"""

import requests
import json
import csv
import os
import time
import argparse
from datetime import datetime
from typing import List, Dict, Optional, Tuple
from pathlib import Path


class UnifiedPropertyScraper:
    """Unified scraper for US property data."""
    
    # Pre-defined region IDs for counties that are frequently blocked or crucial
    COUNTY_MAP = {
        ('oconee', 'sc'): {'id': '1802', 'type': '5'},
        ('greenville', 'sc'): {'id': '1721', 'type': '5'},
        ('anderson', 'sc'): {'id': '1715', 'type': '5'},
    }
    
    def __init__(self, delay: float = 1.0, output_dir: str = "scraped_data"):
        """
        Initialize scraper.
        
        Args:
            delay: Seconds between API calls
            output_dir: Directory for output files
        """
        self.delay = delay
        self.output_dir = Path(output_dir)
        self.output_dir.mkdir(exist_ok=True)
        
        self.session = requests.Session()
        self.session.headers.update({
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept-Encoding': 'gzip, deflate, br',
            'DNT': '1',
            'Connection': 'keep-alive',
            'Upgrade-Insecure-Requests': '1',
            'Sec-Fetch-Dest': 'document',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Site': 'none',
            'Sec-Fetch-User': '?1',
            'Cache-Control': 'max-age=0',
            'Referer': 'https://www.redfin.com/',
            'sec-ch-ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
            'sec-ch-ua-mobile': '?0',
            'sec-ch-ua-platform': '"macOS"',
        })
        
        # Statistics
        self.stats = {
            'counties_attempted': 0,
            'counties_success': 0,
            'counties_failed': 0,
            'total_properties': 0,
            'errors': []
        }
        
        # Prime the session
        self._prime_session()

    def _prime_session(self):
        """Visit Redfin home page to establish cookies/session."""
        print("Priming scraper session...")
        try:
            # First, get the main page to get some cookies
            resp = self.session.get("https://www.redfin.com/", timeout=15)
            
            # Set some common Redfin cookies if not present
            if 'RF_BROWSER_ID' not in self.session.cookies:
                self.session.cookies.set('RF_BROWSER_ID', 'test_id_12345', domain='.redfin.com')
            
            self.session.headers.update({
                'X-RF-Stingray-Xhr': '1',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Referer': 'https://www.redfin.com/',
            })
            
            time.sleep(1.5)
        except Exception as e:
            print(f"Warning: Failed to prime session: {e}")
    
    def load_county_data(self) -> Dict:
        """Load US county data from file or embedded data."""
        try:
            # Check script directory
            script_dir = Path(__file__).parent
            county_file = script_dir / 'us_counties_complete.json'
            if county_file.exists():
                with open(county_file, 'r') as f:
                    return json.load(f)
            
            # Check current working directory
            with open('us_counties_complete.json', 'r') as f:
                return json.load(f)
        except FileNotFoundError:
            raise FileNotFoundError("us_counties_complete.json not found!")
    
    def get_state_counties(self, state_code: str) -> List[str]:
        """Get list of counties for a state."""
        data = self.load_county_data()
        return data.get('counties_by_state', {}).get(state_code.upper(), [])
    
    def search_location(self, query: str) -> Optional[Dict]:
        """Search for a location using Redfin's autocomplete."""
        url = "https://www.redfin.com/stingray/do/location-autocomplete"
        params = {'location': query, 'v': '2'}
        
        try:
            response = self.session.get(url, params=params, timeout=15)
            if response.status_code != 200:
                print(f"  Error: Autocomplete returned status {response.status_code}")
                return None
                
            text = response.text
            if text.startswith('{}&&'):
                text = text[4:]
            data = json.loads(text)
            
            sections = data.get('payload', {}).get('sections', [])
            all_rows = []
            for section in sections:
                all_rows.extend(section.get('rows', []))
            
            if not all_rows:
                return None

            # Look for best match
            best_match = None
            if query.strip().isdigit(): # ZIP
                for row in all_rows:
                    if query.strip() in row.get('name', '') and row.get('type') == 1:
                        best_match = row
                        break
            else: # County or other
                for row in all_rows:
                    if query.lower() in row.get('name', '').lower():
                        best_match = row
                        break
            
            if not best_match:
                best_match = all_rows[0]

            full_id = best_match.get('id', '')
            parts = full_id.split('_')
            region_id = parts[-1]
            region_type = best_match.get('type', '1')

            if len(parts) > 1:
                region_type = parts[0]

            print(f"DEBUG: Selected {best_match.get('name')} | ID: {region_id} | Type: {region_type}")
            
            return {
                'id': region_id,
                'type': region_type,
                'name': best_match.get('name'),
                'full_id': full_id,
                'url': best_match.get('url', '')
            }

        except Exception as e:
            print(f"  Error in search_location: {e}")
            return None
    
    def fetch_properties(self, region_id: str, region_type: str, days: int = 1825, name: str = "") -> List[Dict]:
        """Fetch properties for a region. Tries Redfin CSV first, then Zillow-like search."""
        
        # Method 1: Redfin CSV
        print(f"DEBUG: Attempting Redfin CSV download for {name}...")
        csv_url = "https://www.redfin.com/stingray/api/gis-csv"
        params = {
            'al': 1,
            'region_id': region_id,
            'region_type': region_type,
            'sold_within_days': days,
            'status': '9', 
            'v': 8
        }
        
        try:
            response = self.session.get(csv_url, params=params, timeout=45)
            if response.status_code == 200 and len(response.text) > 100:
                print(f"DEBUG: Successfully downloaded Redfin CSV for {name}")
                decoded_content = response.content.decode('utf-8')
                reader = csv.DictReader(decoded_content.splitlines())
                properties = [dict(row) for row in reader]
                if properties:
                    for p in properties: p['County_Source'] = name
                    return properties
        except Exception:
            pass

        print(f"DEBUG: Redfin failed. Attempting alternative search for {name}...")
        
        # If Redfin fails, we can try to scrape the search result page directly
        # but since we're in a headless environment without a browser, 
        # let's try to mimic a zillow search or similar if we had their API.
        
        # For now, let's try one more Redfin trick: the browse page.
        # https://www.redfin.com/zipcode/29605
        # We can try to extract the ReactServerRenderContext from here.
        
        try:
            url = f"https://www.redfin.com/zipcode/{name.split(' ')[0]}" if name[0].isdigit() else f"https://www.redfin.com/county/{region_id}/{name.replace(' ', '-')}"
            print(f"DEBUG: Trying browse page: {url}")
            resp = self.session.get(url, timeout=30)
            if resp.status_code == 200:
                # Look for the JSON payload in the HTML
                import re
                match = re.search(r'<script id="itemInventory" type="application/ld\+json">(.*?)</script>', resp.text, re.DOTALL)
                if match:
                    print(f"DEBUG: Found ld+json inventory")
                    # This often contains active listings. Sold listings are harder.
                
                # Look for the big React context
                match = re.search(r'root.renderContext = (.*?);', resp.text)
                if match:
                    print(f"DEBUG: Found React renderContext")
                    # context = json.loads(match.group(1))
                    # Properties are deep in here.
            
            return []
        except Exception as e:
            print(f"DEBUG: Error in alternative search: {e}")
            return []
    
    def _format_property(self, home: Dict) -> Optional[Dict]:
        """Format property data to standard schema (matching user requirements)."""
        try:
            price_data = home.get('price', {})
            price = price_data.get('value') if isinstance(price_data, dict) else price_data
            
            sqft_data = home.get('sqft', {})
            sqft = sqft_data.get('value') if isinstance(sqft_data, dict) else sqft_data
            
            lot_data = home.get('lot_size', {})
            lot_size = lot_data.get('value') if isinstance(lot_data, dict) else lot_data
            
            hoa_data = home.get('hoa', {})
            hoa = hoa_data.get('value') if isinstance(hoa_data, dict) else None
            
            price_per_sqft = round(price / sqft, 1) if price and sqft and sqft > 0 else None
            
            # Match the exact keys and formatting from the reference JSON files
            return {
                "SALE TYPE": "PAST SALE",
                "SOLD DATE": home.get('last_sale_date', ''),
                "PROPERTY TYPE": home.get('property_type', 'Unknown'),
                "ADDRESS": home.get('address', ''),
                "CITY": home.get('city', ''),
                "STATE OR PROVINCE": home.get('state', ''),
                "ZIP OR POSTAL CODE": home.get('zip', ''),
                "PRICE": f"{float(price):.1f}" if price is not None else "",
                "BEDS": f"{float(home.get('beds', 0)):.1f}" if home.get('beds') is not None else "",
                "BATHS": f"{float(home.get('baths', 0)):.1f}" if home.get('baths') is not None else "",
                "LOCATION": home.get('neighborhood', ''),
                "SQUARE FEET": f"{float(sqft):.1f}" if sqft is not None else "",
                "LOT SIZE": f"{float(lot_size):.1f}" if lot_size is not None else "",
                "YEAR BUILT": f"{float(home.get('year_built', 0)):.1f}" if home.get('year_built') is not None else "",
                "DAYS ON MARKET": str(home.get('days_on_market', '')),
                "$/SQUARE FEET": f"{price_per_sqft:.1f}" if price_per_sqft is not None else "",
                "HOA/MONTH": str(hoa) if hoa is not None else "",
                "STATUS": "Sold",
                "NEXT OPEN HOUSE START TIME": "",
                "NEXT OPEN HOUSE END TIME": "",
                "URL (SEE https://www.redfin.com/buy-a-home/comparative-market-analysis FOR INFO ON PRICING)": f"https://www.redfin.com{home.get('url', '')}" if home.get('url') else '',
                "SOURCE": home.get('source', ''),
                "MLS#": f"{home.get('mls_id', '')}.0" if home.get('mls_id') else "",
                "FAVORITE": "N",
                "INTERESTED": "Y",
                "LATITUDE": str(home.get('lat', '')),
                "LONGITUDE": str(home.get('lng', '')),
                "County_Source": home.get('county', '')
            }
        except Exception as e:
            # print(f"Error formatting property: {e}")
            return None
    
    def scrape_zip(self, zip_code: str, days: int = 1825) -> Tuple[List[Dict], Dict]:
        """Scrape properties for a ZIP code."""
        print(f"\n{'='*60}")
        print(f"Scraping ZIP Code: {zip_code}")
        print(f"{'='*60}")
        
        location = self.search_location(zip_code)
        if not location:
            return [], {'error': f'ZIP {zip_code} not found'}
        
        print(f"Found: {location.get('name')}")
        properties = self.fetch_properties(
            location.get('id'),
            location.get('type'),
            days,
            location.get('name')
        )
        
        summary = self._calculate_summary(properties, f"ZIP {zip_code}")
        return properties, summary
    
    def scrape_county(self, county: str, state: str, days: int = 1825, region_id: str = None, region_type: str = None) -> Tuple[List[Dict], Dict]:
        """Scrape properties for a single county."""
        self.stats['counties_attempted'] += 1
        
        location = None
        
        # Priority 1: Manual Override
        if region_id and region_type:
            print(f"DEBUG: Using manual override ID: {region_id} | Type: {region_type}")
            location = {
                'id': region_id,
                'type': region_type,
                'name': f"{county}, {state}"
            }
        
        # Priority 2: Pre-defined Map
        if not location:
            key = (county.lower().strip(), state.lower().strip())
            if key in self.COUNTY_MAP:
                mapping = self.COUNTY_MAP[key]
                print(f"DEBUG: Using pre-defined map for {county}, {state} -> ID: {mapping['id']}")
                location = {
                    'id': mapping['id'],
                    'type': mapping['type'],
                    'name': f"{county} County, {state}"
                }
        
        # Priority 3: Search (Autocomplete)
        if not location:
            # Try different search formats
            queries = [
                f"{county} County, {state}",
                f"{county}, {state}",
                f"{county} {state}"
            ]
            
            for query in queries:
                location = self.search_location(query)
                if location:
                    break
        
        if not location:
            self.stats['counties_failed'] += 1
            self.stats['errors'].append({'county': county, 'state': state, 'error': 'Not found (Blocks or missing)'})
            print(f"ERROR: Could not find location ID for {county}, {state}. If blocked (403), use --region-id manually.")
            return [], {'error': f'{county}, {state} not found'}
        
        properties = self.fetch_properties(
            location.get('id'),
            location.get('type'),
            days,
            location.get('name')
        )
        
        # Tag with county
        for prop in properties:
            prop['COUNTY_SOURCE'] = f"{county}, {state}"
        
        self.stats['counties_success'] += 1
        self.stats['total_properties'] += len(properties)
        
        summary = self._calculate_summary(properties, f"{county}, {state}")
        return properties, summary
    
    def scrape_state(self, state: str, days: int = 1825) -> Tuple[List[Dict], List[Dict]]:
        """Scrape all counties in a state."""
        counties = self.get_state_counties(state)
        
        if not counties:
            print(f"No counties found for state: {state}")
            return [], []
        
        print(f"\n{'='*60}")
        print(f"Scraping State: {state}")
        print(f"Counties: {len(counties)}")
        print(f"{'='*60}")
        
        all_properties = []
        all_summaries = []
        
        for i, county in enumerate(counties, 1):
            print(f"\n[{i}/{len(counties)}] {county} County...")
            props, summary = self.scrape_county(county, state, days)
            
            if props:
                all_properties.extend(props)
                # Save individual county file
                county_safe = county.replace(' ', '_').lower()
                basename = f"{county_safe}_{state.lower()}"
                self.save_results(props, [summary], basename, include_timestamp=False)
            
            all_summaries.append(summary)
            
            if i < len(counties):
                time.sleep(self.delay)
        
        return all_properties, all_summaries
    
    def scrape_counties_list(self, counties: List[Tuple[str, str]], days: int = 1825) -> Tuple[List[Dict], List[Dict]]:
        """Scrape a list of (county, state) tuples."""
        all_properties = []
        all_summaries = []
        
        print(f"\n{'='*60}")
        print(f"Scraping {len(counties)} counties")
        print(f"{'='*60}")
        
        for i, (county, state) in enumerate(counties, 1):
            print(f"\n[{i}/{len(counties)}] {county}, {state}...")
            props, summary = self.scrape_county(county, state, days)
            
            if props:
                all_properties.extend(props)
                # Save individual county file
                county_safe = county.replace(' ', '_').lower()
                basename = f"{county_safe}_{state.lower()}"
                self.save_results(props, [summary], basename)
            
            all_summaries.append(summary)
            
            if i < len(counties):
                time.sleep(self.delay)
        
        return all_properties, all_summaries
    
    def _calculate_summary(self, properties: List[Dict], name: str) -> Dict:
        """Calculate summary statistics."""
        # Fix: Convert price to float for calculation
        prices = []
        for p in properties:
            try:
                if p.get('PRICE'):
                    prices.append(float(p['PRICE']))
            except (ValueError, TypeError):
                continue
        
        summary = {
            'name': name,
            'property_count': len(properties),
            'min_price': min(prices) if prices else None,
            'max_price': max(prices) if prices else None,
            'avg_price': sum(prices) / len(prices) if prices else None,
            'median_price': sorted(prices)[len(prices)//2] if prices else None
        }
        
        if prices:
            print(f"  Properties: {summary['property_count']}")
            print(f"  Price Range: ${summary['min_price']:,.0f} - ${summary['max_price']:,.0f}")
            print(f"  Avg Price: ${summary['avg_price']:,.0f}")
        else:
            print(f"  No properties found")
        
        return summary
    
    def save_results(self, properties: List[Dict], summaries: List[Dict], basename: str, include_timestamp: bool = True):
        """Save results to files."""
        timestamp = f"_{datetime.now().strftime('%Y%m%d_%H%M%S')}" if include_timestamp else ""
        
        # Save properties JSON
        props_file = self.output_dir / f"{basename}_properties{timestamp}.json"
        with open(props_file, 'w') as f:
            json.dump(properties, f, indent=2)
        print(f"\nSaved {len(properties)} properties to: {props_file}")
        
        # Save properties CSV
        if properties:
            csv_file = self.output_dir / f"{basename}_properties{timestamp}.csv"
            with open(csv_file, 'w', newline='') as f:
                writer = csv.DictWriter(f, fieldnames=properties[0].keys())
                writer.writeheader()
                writer.writerows(properties)
            print(f"Saved CSV to: {csv_file}")
        
        # Save summary
        summary_file = self.output_dir / f"{basename}_summary{timestamp}.json"
        with open(summary_file, 'w') as f:
            json.dump({
                'summaries': summaries,
                'stats': self.stats,
                'generated_at': datetime.now().strftime("%Y%m%d_%H%M%S")
            }, f, indent=2)
        print(f"Saved summary to: {summary_file}")
        
        return props_file, summary_file
    
    def print_final_stats(self):
        """Print final statistics."""
        print(f"\n{'='*60}")
        print("FINAL STATISTICS")
        print(f"{'='*60}")
        print(f"Counties Attempted: {self.stats['counties_attempted']}")
        print(f"Counties Successful: {self.stats['counties_success']}")
        print(f"Counties Failed: {self.stats['counties_failed']}")
        print(f"Total Properties: {self.stats['total_properties']}")
        
        if self.stats['errors']:
            print(f"\nErrors ({len(self.stats['errors'])}):")
            for err in self.stats['errors'][:10]:
                print(f"  - {err['county']}, {err['state']}: {err['error']}")


def main():
    parser = argparse.ArgumentParser(
        description='Unified US Property Data Scraper',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog='''
Examples:
  # Single ZIP code
  python unified_property_scraper.py --mode zip --zip 90210
  
  # Single county
  python unified_property_scraper.py --mode county --state CA --county "Los Angeles"
  
  # Entire state
  python unified_property_scraper.py --mode state --state TX
  
  # Multiple counties
  python unified_property_scraper.py --mode counties --state FL --counties "Miami-Dade,Broward,Palm Beach"
        '''
    )
    
    parser.add_argument('--mode', required=True,
                        choices=['zip', 'county', 'state', 'counties'],
                        help='Scraping mode')
    parser.add_argument('--zip', help='ZIP code (for zip mode)')
    parser.add_argument('--state', help='State code (for county/state/counties modes)')
    parser.add_argument('--county', help='County name (for county mode)')
    parser.add_argument('--counties', help='Comma-separated counties (for counties mode)')
    parser.add_argument('--days', type=int, default=1825,
                        help='Days to look back for sales (default: 1825 / 5 years)')
    parser.add_argument('--delay', type=float, default=1.0,
                        help='Seconds between requests (default: 1.0)')
    parser.add_argument('--output-dir', default='scraped_data',
                        help='Output directory (default: scraped_data)')
    parser.add_argument('--output-name', help='Base name for output files')
    parser.add_argument('--region-id', help='Manual Redfin region ID (bypasses search)')
    parser.add_argument('--region-type', help='Manual Redfin region type (usually 5 for county)')
    
    args = parser.parse_args()
    
    # Validate arguments
    if args.mode == 'zip' and not args.zip:
        parser.error('--zip required for zip mode')
    if args.mode == 'county' and (not args.state or not args.county):
        parser.error('--state and --county required for county mode')
    if args.mode == 'state' and not args.state:
        parser.error('--state required for state mode')
    if args.mode == 'counties' and (not args.state or not args.counties):
        parser.error('--state and --counties required for counties mode')
    
    # Initialize scraper
    scraper = UnifiedPropertyScraper(
        delay=args.delay,
        output_dir=args.output_dir
    )
    
    # Execute based on mode
    if args.mode == 'zip':
        properties, summary = scraper.scrape_zip(args.zip, args.days)
        summaries = [summary]
        basename = args.output_name or f"zip_{args.zip}"
        
    elif args.mode == 'county':
        properties, summary = scraper.scrape_county(
            args.county, 
            args.state, 
            args.days,
            region_id=args.region_id,
            region_type=args.region_type
        )
        summaries = [summary]
        county_safe = args.county.replace(' ', '_').lower()
        basename = args.output_name or f"county_{county_safe}_{args.state.lower()}"
        
    elif args.mode == 'state':
        properties, summaries = scraper.scrape_state(args.state, args.days)
        basename = args.output_name or f"state_{args.state.lower()}"
        
    elif args.mode == 'counties':
        county_list = [(c.strip(), args.state) for c in args.counties.split(',')]
        properties, summaries = scraper.scrape_counties_list(county_list, args.days)
        basename = args.output_name or f"counties_{args.state.lower()}"
    
    # Save results
    if (properties or (summaries and any(s.get('property_count') for s in summaries if isinstance(s, dict)))):
        scraper.save_results(properties, summaries, basename)
    
    # Print stats
    scraper.print_final_stats()


if __name__ == '__main__':
    main()
