"""
Check current scraping status
Shows what scripts exist, what data has been collected, and progress.
"""

from pathlib import Path
import json

def main():
    print('='*60)
    print('NATIONWIDE SCRAPING PROJECT - CURRENT STATUS')
    print('='*60)
    
    # Check scripts
    scripts = [
        'fetch_us_zipcodes.py',
        'nationwide_property_scraper.py', 
        'county_batch_scraper.py',
        'high_speed_scraper.py',
        'no_proxy_scraper.py',
        'proxy_manager.py',
        'insert_to_database.py',
        'monitoring_dashboard.py',
        'master_orchestrator.py',
        'setup_proxies.py',
        'PROXY_SETUP_GUIDE.md'
    ]
    
    print('\n📜 AVAILABLE SCRIPTS:')
    for script in scripts:
        exists = '✓' if Path(script).exists() else '✗'
        print(f'  {exists} {script}')
    
    # Check data directories
    print('\n💾 DATA STATUS:')
    data_dirs = {
        '../data': 'Main data folder',
        '../data/scraped': 'Standard scraper',
        '../data/scraped_counties': 'County batch scraper',
        '../data/scraped_fast': 'High-speed scraper',
        '../data/scraped_no_proxy': 'No-proxy scraper'
    }
    
    for d, desc in data_dirs.items():
        path = Path(d)
        if path.exists():
            files = list(path.rglob('*'))
            json_files = [f for f in files if f.suffix == '.json' and f.is_file()]
            csv_files = [f for f in files if f.suffix == '.csv' and f.is_file()]
            total_size = sum(f.stat().st_size for f in files if f.is_file()) / (1024*1024)
            print(f'  ✓ {desc}')
            print(f'     {len(json_files)} JSON files, {len(csv_files)} CSV files, {total_size:.1f} MB total')
        else:
            print(f'  ✗ {desc} - Empty')
    
    # Check progress files
    print('\n📊 SCRAPING PROGRESS:')
    progress_files = {
        '../data/scraping_progress.json': 'Original scraper',
        '../data/scraped_counties/county_progress.json': 'County scraper',
        '../data/scraped_no_proxy/progress.json': 'No-proxy scraper'
    }
    
    for pf, desc in progress_files.items():
        path = Path(pf)
        if path.exists():
            try:
                with open(path, 'r') as f:
                    data = json.load(f)
                completed = len(data.get('completed', []))
                failed = len(data.get('failed', []))
                print(f'  ✓ {desc}: {completed} completed, {failed} failed')
            except:
                print(f'  ✓ {desc}: Progress file exists')
        else:
            print(f'  ✗ {desc}: Not started')
    
    # Check ZIP codes file
    print('\n📮 ZIP CODE DATA:')
    zip_file = Path('../data/us_zipcodes.json')
    if zip_file.exists():
        try:
            with open(zip_file, 'r') as f:
                data = json.load(f)
            zips = data.get('zip_codes', [])
            print(f'  ✓ {len(zips)} ZIP codes available')
        except:
            print(f'  ✓ ZIP file exists')
    else:
        print(f'  ✗ No ZIP code data (run fetch_us_zipcodes.py)')
    
    print('\n' + '='*60)
    print('NEXT STEPS:')
    print('='*60)
    
    # Check if any scraping has started
    any_progress = any([
        Path('../data/scraping_progress.json').exists(),
        Path('../data/scraped_counties/county_progress.json').exists(),
        Path('../data/scraped_no_proxy/progress.json').exists()
    ])
    
    if any_progress:
        print('1. Resume scraping:')
        print('   python no_proxy_scraper.py  # or county_batch_scraper.py')
        print('\n2. Check detailed progress:')
        print('   python monitoring_dashboard.py --status')
    else:
        print('1. Start scraping (EASIEST - no setup needed):')
        print('   python no_proxy_scraper.py')
        print('   Estimated time: 2-3 hours')
        print('\n2. Faster with proxies:')
        print('   python setup_proxies.py  # Follow wizard')
        print('   python county_batch_scraper.py --workers 100 --proxies proxies.txt')
        print('   Estimated time: 10-30 minutes')
    
    print('\n3. Insert into database when done:')
    print('   python insert_to_database.py --input data/scraped_no_proxy')
    print('='*60)

if __name__ == '__main__':
    main()
