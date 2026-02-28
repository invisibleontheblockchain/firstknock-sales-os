"""
Monitoring Dashboard for Nationwide Scraping Operation
======================================================
Real-time monitoring and statistics for the scraping pipeline.

Usage:
    python monitoring_dashboard.py --watch
    python monitoring_dashboard.py --report
    python monitoring_dashboard.py --stats
"""

import json
import time
import argparse
from pathlib import Path
from datetime import datetime, timedelta
from typing import Dict, List
import os


class ScrapingMonitor:
    """Monitor the scraping operation."""
    
    def __init__(self, data_dir: str = "data"):
        self.data_dir = Path(data_dir)
        self.progress_file = self.data_dir / "scraping_progress.json"
        self.state_file = self.data_dir / "pipeline_state.json"
    
    def load_progress(self) -> Dict:
        """Load scraping progress."""
        if self.progress_file.exists():
            with open(self.progress_file, 'r') as f:
                return json.load(f)
        return {}
    
    def load_state(self) -> Dict:
        """Load pipeline state."""
        if self.state_file.exists():
            with open(self.state_file, 'r') as f:
                return json.load(f)
        return {}
    
    def count_scraped_files(self) -> Dict:
        """Count scraped files by type and state."""
        scraped_dir = self.data_dir / "scraped"
        
        if not scraped_dir.exists():
            return {'total': 0, 'by_state': {}, 'by_zip': 0}
        
        stats = {
            'total_files': 0,
            'by_state': {},
            'by_zip_files': 0,
            'total_size_mb': 0
        }
        
        for file_path in scraped_dir.rglob('*'):
            if file_path.is_file():
                stats['total_files'] += 1
                stats['total_size_mb'] += file_path.stat().st_size / (1024 * 1024)
                
                # Categorize by type
                if file_path.suffix == '.csv':
                    # Extract state from filename (properties_ca.csv)
                    parts = file_path.stem.split('_')
                    if len(parts) >= 2:
                        state = parts[-1].upper()
                        stats['by_state'][state] = stats['by_state'].get(state, 0) + 1
                elif file_path.suffix == '.json' and file_path.parent.name == 'by_zip':
                    stats['by_zip_files'] += 1
        
        stats['total_size_mb'] = round(stats['total_size_mb'], 2)
        return stats
    
    def estimate_completion(self, progress: Dict) -> Dict:
        """Estimate completion time based on progress."""
        completed = len(progress.get('completed_zip_codes', []))
        total = progress.get('total_zips', 0)
        failed = len(progress.get('failed_zip_codes', []))
        
        if total == 0:
            return {'percent': 0, 'eta': 'Unknown', 'rate': 0}
        
        percent = (completed / total) * 100
        
        # Calculate rate
        started = progress.get('started_at', '')
        if started:
            try:
                start_time = datetime.fromisoformat(started)
                elapsed = (datetime.now() - start_time).total_seconds()
                rate = completed / elapsed if elapsed > 0 else 0  # zips per second
                
                remaining = total - completed
                eta_seconds = remaining / rate if rate > 0 else 0
                eta = str(timedelta(seconds=int(eta_seconds)))
                
                return {
                    'percent': round(percent, 2),
                    'completed': completed,
                    'total': total,
                    'failed': failed,
                    'remaining': remaining,
                    'eta': eta,
                    'rate': round(rate * 3600, 2)  # zips per hour
                }
            except:
                pass
        
        return {
            'percent': round(percent, 2),
            'completed': completed,
            'total': total,
            'failed': failed,
            'remaining': total - completed,
            'eta': 'Unknown',
            'rate': 0
        }
    
    def print_dashboard(self):
        """Print monitoring dashboard."""
        progress = self.load_progress()
        state = self.load_state()
        files = self.count_scraped_files()
        estimate = self.estimate_completion(progress)
        
        os.system('cls' if os.name == 'nt' else 'clear')
        
        print("="*70)
        print("           NATIONWIDE PROPERTY SCRAPING - MONITORING DASHBOARD")
        print("="*70)
        print(f"Last updated: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
        print("="*70)
        
        # Progress Section
        print("\n📊 PROGRESS")
        print("-"*70)
        if estimate['total'] > 0:
            bar_length = 40
            filled = int(bar_length * estimate['percent'] / 100)
            bar = '█' * filled + '░' * (bar_length - filled)
            print(f"[{bar}] {estimate['percent']:.1f}%")
            print(f"  Completed: {estimate['completed']:,} / {estimate['total']:,} ZIP codes")
            print(f"  Failed: {estimate['failed']:,}")
            print(f"  Remaining: {estimate['remaining']:,}")
            print(f"  Rate: {estimate['rate']:.1f} ZIPs/hour")
            print(f"  ETA: {estimate['eta']}")
        else:
            print("  No progress data available yet.")
        
        # Pipeline State
        print("\n📋 PIPELINE STATE")
        print("-"*70)
        if state:
            print(f"  Started: {state.get('started_at', 'Not started')}")
            print(f"  Current step: {state.get('current_step', 'None')}")
            print(f"  Completed: {', '.join(state.get('completed_steps', []))}")
            if state.get('errors'):
                print(f"  Errors: {len(state['errors'])}")
        else:
            print("  No pipeline state available.")
        
        # Files Section
        print("\n💾 SCRAPED DATA")
        print("-"*70)
        print(f"  Total files: {files['total_files']:,}")
        print(f"  Total size: {files['total_size_mb']:.2f} MB")
        print(f"  ZIP-level JSON files: {files.get('by_zip_files', 0):,}")
        
        if files['by_state']:
            print(f"\n  By State:")
            sorted_states = sorted(files['by_state'].items(), key=lambda x: -x[1])[:10]
            for state, count in sorted_states:
                print(f"    {state}: {count:,} files")
        
        # Recent Properties
        total_props = progress.get('total_properties', 0)
        if total_props > 0:
            print(f"\n🏠 PROPERTIES COLLECTED")
            print("-"*70)
            print(f"  Total: {total_props:,}")
            avg_per_zip = total_props / max(estimate['completed'], 1)
            print(f"  Average per ZIP: {avg_per_zip:.1f}")
            if estimate['remaining'] > 0:
                projected_total = total_props + (avg_per_zip * estimate['remaining'])
                print(f"  Projected total: {projected_total:,.0f}")
        
        # Current Activity
        current_zip = progress.get('current_zip', '')
        if current_zip:
            print(f"\n🔄 CURRENT ACTIVITY")
            print("-"*70)
            print(f"  Processing ZIP: {current_zip}")
        
        print("\n" + "="*70)
        print("Press Ctrl+C to exit")
        print("="*70)
    
    def print_report(self):
        """Print detailed report."""
        progress = self.load_progress()
        state = self.load_state()
        files = self.count_scraped_files()
        
        print("="*70)
        print("               NATIONWIDE SCRAPING - DETAILED REPORT")
        print("="*70)
        print(f"Generated: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
        print("="*70)
        
        # Progress Summary
        print("\n📊 PROGRESS SUMMARY")
        print("-"*70)
        completed = len(progress.get('completed_zip_codes', []))
        failed = len(progress.get('failed_zip_codes', []))
        total = progress.get('total_zips', 0)
        
        print(f"Total ZIP codes: {total:,}")
        print(f"Completed: {completed:,}")
        print(f"Failed: {failed:,}")
        print(f"Success rate: {(completed/max(total,1)*100):.1f}%")
        
        # Properties
        total_props = progress.get('total_properties', 0)
        print(f"\nTotal properties collected: {total_props:,}")
        if completed > 0:
            print(f"Average properties per ZIP: {total_props/completed:.1f}")
        
        # Failed ZIPs
        if progress.get('failed_zip_codes'):
            print(f"\n❌ FAILED ZIP CODES ({len(progress['failed_zip_codes'])})")
            print("-"*70)
            for fail in progress['failed_zip_codes'][:20]:
                print(f"  {fail['zip']}: {fail.get('error', 'Unknown error')}")
            if len(progress['failed_zip_codes']) > 20:
                print(f"  ... and {len(progress['failed_zip_codes']) - 20} more")
        
        # File Summary
        print(f"\n💾 FILE SUMMARY")
        print("-"*70)
        print(f"Total files: {files['total_files']}")
        print(f"Total size: {files['total_size_mb']:.2f} MB")
        
        if files['by_state']:
            print(f"\nFiles by state:")
            for state, count in sorted(files['by_state'].items()):
                print(f"  {state}: {count}")
        
        # Pipeline History
        if state.get('completed_steps'):
            print(f"\n✅ COMPLETED STEPS")
            print("-"*70)
            for step in state['completed_steps']:
                print(f"  ✓ {step}")
        
        print("\n" + "="*70)
    
    def watch(self, interval: int = 10):
        """Watch mode - continuously update dashboard."""
        print("Starting monitoring dashboard...")
        print(f"Update interval: {interval} seconds")
        print("Press Ctrl+C to exit\n")
        
        try:
            while True:
                self.print_dashboard()
                time.sleep(interval)
        except KeyboardInterrupt:
            print("\n\nMonitoring stopped.")


def main():
    parser = argparse.ArgumentParser(
        description='Monitoring dashboard for nationwide scraping',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog='''
Examples:
  # Watch mode (live updates)
  python monitoring_dashboard.py --watch
  
  # Watch with custom interval (seconds)
  python monitoring_dashboard.py --watch --interval 30
  
  # Print detailed report
  python monitoring_dashboard.py --report
  
  # Quick stats
  python monitoring_dashboard.py --stats
        '''
    )
    
    parser.add_argument('--watch', action='store_true',
                        help='Watch mode with live updates')
    parser.add_argument('--interval', type=int, default=10,
                        help='Update interval in seconds (default: 10)')
    parser.add_argument('--report', action='store_true',
                        help='Print detailed report')
    parser.add_argument('--stats', action='store_true',
                        help='Print quick stats')
    parser.add_argument('--data-dir', default='data',
                        help='Data directory (default: data)')
    
    args = parser.parse_args()
    
    monitor = ScrapingMonitor(data_dir=args.data_dir)
    
    if args.watch:
        monitor.watch(interval=args.interval)
    elif args.report:
        monitor.print_report()
    elif args.stats:
        progress = monitor.load_progress()
        files = monitor.count_scraped_files()
        estimate = monitor.estimate_completion(progress)
        
        print(f"Progress: {estimate.get('percent', 0):.1f}%")
        print(f"Completed: {estimate.get('completed', 0):,} / {estimate.get('total', 0):,} ZIPs")
        print(f"Properties: {progress.get('total_properties', 0):,}")
        print(f"Files: {files['total_files']}")
        print(f"Data size: {files['total_size_mb']:.2f} MB")
    else:
        parser.print_help()


if __name__ == '__main__':
    main()
