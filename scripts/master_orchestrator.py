"""
Master Orchestrator for Nationwide Property Data Collection
===========================================================
Coordinates the entire pipeline:
1. Fetch US ZIP codes
2. Scrape properties from Redfin
3. Insert into database

Usage:
    # Full pipeline
    python master_orchestrator.py --run-all
    
    # Step by step
    python master_orchestrator.py --step zipcodes
    python master_orchestrator.py --step scrape --state CA
    python master_orchestrator.py --step insert
    
    # Resume interrupted job
    python master_orchestrator.py --resume
    
    # Scrape specific states
    python master_orchestrator.py --states CA,TX,FL,NY
"""

import os
import sys
import json
import time
import argparse
import subprocess
from pathlib import Path
from datetime import datetime
from typing import List, Dict, Optional
from dataclasses import dataclass, asdict


@dataclass
class PipelineConfig:
    """Configuration for the data pipeline."""
    output_dir: str = "data"
    scraped_dir: str = "data/scraped"
    delay: float = 2.0
    days: int = 1825  # 5 years
    batch_size: int = 1000
    states: List[str] = None
    resume: bool = False
    
    def __post_init__(self):
        if self.states is None:
            self.states = []
        Path(self.output_dir).mkdir(parents=True, exist_ok=True)
        Path(self.scraped_dir).mkdir(parents=True, exist_ok=True)


class PipelineOrchestrator:
    """Orchestrates the entire data collection pipeline."""
    
    def __init__(self, config: PipelineConfig):
        self.config = config
        self.scripts_dir = Path(__file__).parent
        self.start_time = None
        self.end_time = None
        
        # Pipeline state
        self.state_file = Path(config.output_dir) / "pipeline_state.json"
        self.state = self._load_state()
    
    def _load_state(self) -> Dict:
        """Load pipeline state from file."""
        if self.state_file.exists():
            with open(self.state_file, 'r') as f:
                return json.load(f)
        return {
            'started_at': None,
            'completed_steps': [],
            'current_step': None,
            'errors': []
        }
    
    def _save_state(self):
        """Save pipeline state to file."""
        with open(self.state_file, 'w') as f:
            json.dump(self.state, f, indent=2)
    
    def _run_script(self, script_name: str, args: List[str]) -> bool:
        """Run a Python script with arguments."""
        script_path = self.scripts_dir / script_name
        
        if not script_path.exists():
            print(f"Error: Script not found: {script_path}")
            return False
        
        cmd = [sys.executable, str(script_path)] + args
        
        print(f"\n{'='*60}")
        print(f"RUNNING: {script_name}")
        print(f"{'='*60}")
        print(f"Command: {' '.join(cmd)}\n")
        
        try:
            result = subprocess.run(cmd, check=True)
            return result.returncode == 0
        except subprocess.CalledProcessError as e:
            print(f"Error running {script_name}: {e}")
            self.state['errors'].append({
                'script': script_name,
                'error': str(e),
                'timestamp': datetime.now().isoformat()
            })
            self._save_state()
            return False
    
    def step_fetch_zipcodes(self) -> bool:
        """Step 1: Fetch all US ZIP codes."""
        print("\n" + "="*60)
        print("STEP 1: Fetch US ZIP Codes")
        print("="*60)
        
        output_file = Path(self.config.output_dir) / "us_zipcodes.json"
        if output_file.exists() and not self.config.resume:
            print(f"ZIP codes file already exists: {output_file}")
            response = input("Regenerate? (y/N): ")
            if response.lower() != 'y':
                print("Skipping ZIP code fetch...")
                return True
        
        self.state['current_step'] = 'fetch_zipcodes'
        self._save_state()
        
        success = self._run_script('fetch_us_zipcodes.py', [])
        
        if success:
            self.state['completed_steps'].append('fetch_zipcodes')
            self._save_state()
        
        return success
    
    def step_scrape(self) -> bool:
        """Step 2: Scrape properties from Redfin."""
        print("\n" + "="*60)
        print("STEP 2: Scrape Properties from Redfin")
        print("="*60)
        
        self.state['current_step'] = 'scrape'
        self._save_state()
        
        if self.config.states:
            # Scrape specific states
            for state in self.config.states:
                print(f"\n--- Scraping state: {state} ---")
                args = [
                    '--mode', 'state',
                    '--state', state,
                    '--days', str(self.config.days),
                    '--delay', str(self.config.delay),
                    '--output-dir', self.config.scraped_dir,
                    '--zip-file', f'{self.config.output_dir}/us_zipcodes.json'
                ]
                
                if self.config.resume:
                    args.extend(['--mode', 'resume'])
                
                success = self._run_script('nationwide_property_scraper.py', args)
                
                if not success:
                    print(f"Warning: Failed to scrape state {state}")
        else:
            # Scrape all
            args = [
                '--mode', 'resume' if self.config.resume else 'all',
                '--days', str(self.config.days),
                '--delay', str(self.config.delay),
                '--output-dir', self.config.scraped_dir,
                '--zip-file', f'{self.config.output_dir}/us_zipcodes.json'
            ]
            
            success = self._run_script('nationwide_property_scraper.py', args)
        
        if success:
            self.state['completed_steps'].append('scrape')
            self._save_state()
        
        return success
    
    def step_insert_to_db(self) -> bool:
        """Step 3: Insert scraped data into database."""
        print("\n" + "="*60)
        print("STEP 3: Insert Data into Database")
        print("="*60)
        
        self.state['current_step'] = 'insert'
        self._save_state()
        
        args = [
            '--input', self.config.scraped_dir,
            '--batch-size', str(self.config.batch_size)
        ]
        
        success = self._run_script('insert_to_database.py', args)
        
        if success:
            self.state['completed_steps'].append('insert')
            self._save_state()
        
        return success
    
    def run_full_pipeline(self):
        """Run the complete pipeline."""
        self.start_time = datetime.now()
        self.state['started_at'] = self.start_time.isoformat()
        self._save_state()
        
        print("\n" + "="*60)
        print("NATIONWIDE PROPERTY DATA COLLECTION PIPELINE")
        print("="*60)
        print(f"Started at: {self.start_time}")
        print(f"Output directory: {self.config.output_dir}")
        print(f"States: {', '.join(self.config.states) if self.config.states else 'All'}")
        print(f"Days to scrape: {self.config.days}")
        print(f"Delay: {self.config.delay}s")
        print("="*60)
        
        try:
            # Step 1: Fetch ZIP codes
            if 'fetch_zipcodes' not in self.state['completed_steps']:
                if not self.step_fetch_zipcodes():
                    print("\n✗ Pipeline failed at step: fetch_zipcodes")
                    return False
            else:
                print("\n✓ Step already completed: fetch_zipcodes")
            
            # Step 2: Scrape properties
            if 'scrape' not in self.state['completed_steps']:
                if not self.step_scrape():
                    print("\n✗ Pipeline failed at step: scrape")
                    return False
            else:
                print("\n✓ Step already completed: scrape")
            
            # Step 3: Insert to database
            if 'insert' not in self.state['completed_steps']:
                if not self.step_insert_to_db():
                    print("\n✗ Pipeline failed at step: insert")
                    return False
            else:
                print("\n✓ Step already completed: insert")
            
            self.end_time = datetime.now()
            duration = self.end_time - self.start_time
            
            print("\n" + "="*60)
            print("PIPELINE COMPLETED SUCCESSFULLY")
            print("="*60)
            print(f"Started: {self.start_time}")
            print(f"Completed: {self.end_time}")
            print(f"Duration: {duration}")
            print("="*60)
            
            return True
            
        except KeyboardInterrupt:
            print("\n\nPipeline interrupted by user.")
            print("Run with --resume to continue from where you left off.")
            return False
        except Exception as e:
            print(f"\n\nPipeline failed with error: {e}")
            return False
    
    def print_status(self):
        """Print current pipeline status."""
        print("\n" + "="*60)
        print("PIPELINE STATUS")
        print("="*60)
        print(f"Started at: {self.state.get('started_at', 'Not started')}")
        print(f"Current step: {self.state.get('current_step', 'None')}")
        print(f"Completed steps: {', '.join(self.state.get('completed_steps', []))}")
        
        if self.state.get('errors'):
            print(f"\nErrors ({len(self.state['errors'])}):")
            for err in self.state['errors'][-5:]:
                print(f"  - {err['script']}: {err['error']}")
    
    def reset(self):
        """Reset pipeline state."""
        if self.state_file.exists():
            self.state_file.unlink()
            print("Pipeline state reset.")
        
        # Also reset scraper progress
        progress_file = Path(self.config.output_dir) / "scraping_progress.json"
        if progress_file.exists():
            progress_file.unlink()
            print("Scraper progress reset.")


def main():
    parser = argparse.ArgumentParser(
        description='Master orchestrator for nationwide property data collection',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog='''
Examples:
  # Run full pipeline
  python master_orchestrator.py --run-all
  
  # Run specific steps
  python master_orchestrator.py --step zipcodes
  python master_orchestrator.py --step scrape --states CA,TX,FL
  python master_orchestrator.py --step insert
  
  # Resume interrupted pipeline
  python master_orchestrator.py --resume
  
  # Check status
  python master_orchestrator.py --status
  
  # Reset and start fresh
  python master_orchestrator.py --reset --run-all
        '''
    )
    
    parser.add_argument('--run-all', action='store_true',
                        help='Run the complete pipeline')
    parser.add_argument('--step',
                        choices=['zipcodes', 'scrape', 'insert'],
                        help='Run a specific step')
    parser.add_argument('--states',
                        help='Comma-separated list of states to scrape (e.g., CA,TX,FL)')
    parser.add_argument('--resume', action='store_true',
                        help='Resume from last checkpoint')
    parser.add_argument('--status', action='store_true',
                        help='Show pipeline status')
    parser.add_argument('--reset', action='store_true',
                        help='Reset pipeline state')
    parser.add_argument('--output-dir', default='data',
                        help='Output directory (default: data)')
    parser.add_argument('--delay', type=float, default=2.0,
                        help='Delay between requests in seconds (default: 2.0)')
    parser.add_argument('--days', type=int, default=1825,
                        help='Days to look back (default: 1825 = 5 years)')
    parser.add_argument('--batch-size', type=int, default=1000,
                        help='Database batch size (default: 1000)')
    
    args = parser.parse_args()
    
    # Parse states
    states = args.states.split(',') if args.states else []
    
    # Create config
    config = PipelineConfig(
        output_dir=args.output_dir,
        delay=args.delay,
        days=args.days,
        batch_size=args.batch_size,
        states=states,
        resume=args.resume
    )
    
    # Create orchestrator
    orchestrator = PipelineOrchestrator(config)
    
    # Execute based on arguments
    if args.status:
        orchestrator.print_status()
    
    elif args.reset:
        orchestrator.reset()
    
    elif args.run_all:
        success = orchestrator.run_full_pipeline()
        sys.exit(0 if success else 1)
    
    elif args.step == 'zipcodes':
        success = orchestrator.step_fetch_zipcodes()
        sys.exit(0 if success else 1)
    
    elif args.step == 'scrape':
        success = orchestrator.step_scrape()
        sys.exit(0 if success else 1)
    
    elif args.step == 'insert':
        success = orchestrator.step_insert_to_db()
        sys.exit(0 if success else 1)
    
    else:
        parser.print_help()


if __name__ == '__main__':
    main()
