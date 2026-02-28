"""
Database Insertion Pipeline for Scraped Properties
=================================================
Inserts scraped property data into PostgreSQL/Neon database.
Handles batch inserts, duplicates, and data normalization.

Usage:
    python insert_to_database.py --input data/scraped/by_zip
    python insert_to_database.py --input data/scraped/properties_ca.csv
    python insert_to_database.py --input data/scraped --batch-size 1000
"""

import os
import json
import csv
import hashlib
import argparse
from datetime import datetime
from pathlib import Path
from typing import List, Dict, Optional, Set
from dataclasses import dataclass

# Database imports - will work with either psycopg2 or postgres driver
try:
    import psycopg2
    from psycopg2.extras import execute_batch
    PSYCOPG2_AVAILABLE = True
except ImportError:
    PSYCOPG2_AVAILABLE = False

try:
    from postgres import Postgres
    POSTGRES_AVAILABLE = True
except ImportError:
    POSTGRES_AVAILABLE = False


@dataclass
class PropertyRecord:
    """Standardized property record matching database schema."""
    address: str
    full_address: str
    city: str
    state: str
    zip_code: str
    latitude: Optional[float]
    longitude: Optional[float]
    beds: Optional[int]
    baths: Optional[float]
    sqft: Optional[int]
    year_built: Optional[int]
    price: Optional[float]
    sold_date: Optional[str]
    address_hash: str
    smart_score: Optional[float] = None
    property_type: Optional[str] = None
    lot_size: Optional[float] = None
    hoa_month: Optional[float] = None
    url: Optional[str] = None
    mls_number: Optional[str] = None
    days_on_market: Optional[int] = None
    price_per_sqft: Optional[float] = None
    county: Optional[str] = None


class DatabaseInserter:
    """Handles database insertion of property records."""
    
    def __init__(
        self,
        connection_string: Optional[str] = None,
        batch_size: int = 1000,
        skip_duplicates: bool = True
    ):
        self.batch_size = batch_size
        self.skip_duplicates = skip_duplicates
        self.connection_string = connection_string or self._get_connection_string()
        self.conn = None
        self.cursor = None
        
        # Statistics
        self.stats = {
            'files_processed': 0,
            'records_processed': 0,
            'records_inserted': 0,
            'records_skipped': 0,
            'records_failed': 0,
            'batches_executed': 0
        }
    
    def _get_connection_string(self) -> str:
        """Get database connection string from environment or default."""
        # Try environment variable first
        conn_str = os.getenv('DATABASE_URL') or os.getenv('NEON_DATABASE_URL')
        
        if conn_str:
            return conn_str
        
        # Default Neon connection (from existing codebase)
        return (
            "postgresql://neondb_owner:npg_jsLScDO6w9mf@"
            "ep-fragrant-bush-ahixbnax-pooler.c-3.us-east-1.aws.neon.tech/"
            "neondb?sslmode=require"
        )
    
    def connect(self):
        """Establish database connection."""
        if not PSYCOPG2_AVAILABLE:
            raise ImportError("psycopg2 is required for database insertion. Install with: pip install psycopg2-binary")
        
        print(f"Connecting to database...")
        self.conn = psycopg2.connect(self.connection_string)
        self.cursor = self.conn.cursor()
        print("✓ Connected successfully")
        
        # Ensure table exists
        self._ensure_table()
    
    def _ensure_table(self):
        """Ensure properties table exists with correct schema."""
        create_table_sql = """
        CREATE TABLE IF NOT EXISTS properties (
            id SERIAL PRIMARY KEY,
            address TEXT,
            full_address TEXT,
            city TEXT,
            state TEXT,
            zip_code VARCHAR(10),
            latitude REAL,
            longitude REAL,
            beds INTEGER,
            baths REAL,
            sqft INTEGER,
            year_built INTEGER,
            price REAL,
            sold_date TEXT,
            address_hash TEXT UNIQUE,
            smart_score REAL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            property_type TEXT,
            lot_size REAL,
            hoa_month REAL,
            url TEXT,
            mls_number TEXT,
            days_on_market INTEGER,
            price_per_sqft REAL,
            county TEXT
        );
        
        CREATE INDEX IF NOT EXISTS idx_properties_zip ON properties(zip_code);
        CREATE INDEX IF NOT EXISTS idx_properties_state ON properties(state);
        CREATE INDEX IF NOT EXISTS idx_properties_city ON properties(city);
        CREATE INDEX IF NOT EXISTS idx_properties_hash ON properties(address_hash);
        CREATE INDEX IF NOT EXISTS idx_properties_sold_date ON properties(sold_date);
        """
        
        self.cursor.execute(create_table_sql)
        self.conn.commit()
        print("✓ Table schema verified")
    
    def close(self):
        """Close database connection."""
        if self.cursor:
            self.cursor.close()
        if self.conn:
            self.conn.close()
            print("✓ Database connection closed")
    
    def _generate_address_hash(self, record: Dict) -> str:
        """Generate unique hash for address deduplication."""
        address_parts = [
            record.get('address', ''),
            record.get('city', ''),
            record.get('state', ''),
            record.get('zip_code', ''),
            str(record.get('latitude', '')),
            str(record.get('longitude', ''))
        ]
        address_str = '|'.join(address_parts).lower().strip()
        return hashlib.md5(address_str.encode()).hexdigest()[:16]
    
    def _parse_redfin_csv_row(self, row: Dict) -> Optional[PropertyRecord]:
        """Parse a Redfin CSV row into a PropertyRecord."""
        try:
            # Extract fields from Redfin CSV format
            address = row.get('ADDRESS', row.get('address', ''))
            city = row.get('CITY', row.get('city', ''))
            state = row.get('STATE OR PROVINCE', row.get('state', ''))
            zip_code = row.get('ZIP OR POSTAL CODE', row.get('zip', ''))
            
            # Parse numeric fields
            def parse_float(val):
                if not val:
                    return None
                try:
                    return float(str(val).replace(',', '').replace('$', ''))
                except:
                    return None
            
            def parse_int(val):
                if not val:
                    return None
                try:
                    return int(float(str(val).replace(',', '')))
                except:
                    return None
            
            latitude = parse_float(row.get('LATITUDE', row.get('latitude', '')))
            longitude = parse_float(row.get('LONGITUDE', row.get('longitude', '')))
            beds = parse_int(row.get('BEDS', row.get('beds', '')))
            baths = parse_float(row.get('BATHS', row.get('baths', '')))
            sqft = parse_int(row.get('SQUARE FEET', row.get('sqft', '')))
            year_built = parse_int(row.get('YEAR BUILT', row.get('year_built', '')))
            price = parse_float(row.get('PRICE', row.get('price', '')))
            lot_size = parse_float(row.get('LOT SIZE', row.get('lot_size', '')))
            hoa_month = parse_float(row.get('HOA/MONTH', row.get('hoa_month', '')))
            days_on_market = parse_int(row.get('DAYS ON MARKET', row.get('days_on_market', '')))
            price_per_sqft = parse_float(row.get('$/SQUARE FEET', row.get('price_per_sqft', '')))
            
            sold_date = row.get('SOLD DATE', row.get('sold_date', ''))
            property_type = row.get('PROPERTY TYPE', row.get('property_type', ''))
            url = row.get('URL (SEE https://www.redfin.com/buy-a-home/comparative-market-analysis FOR INFO ON PRICING)', 
                        row.get('url', ''))
            mls_number = row.get('MLS#', row.get('mls_number', ''))
            county = row.get('COUNTY', row.get('county', ''))
            
            # Build full address
            full_address = f"{address}, {city}, {state} {zip_code}".strip(', ')
            
            # Generate address hash
            address_hash = self._generate_address_hash({
                'address': address,
                'city': city,
                'state': state,
                'zip_code': zip_code,
                'latitude': latitude,
                'longitude': longitude
            })
            
            return PropertyRecord(
                address=address,
                full_address=full_address,
                city=city,
                state=state,
                zip_code=zip_code,
                latitude=latitude,
                longitude=longitude,
                beds=beds,
                baths=baths,
                sqft=sqft,
                year_built=year_built,
                price=price,
                sold_date=sold_date,
                address_hash=address_hash,
                property_type=property_type,
                lot_size=lot_size,
                hoa_month=hoa_month,
                url=url,
                mls_number=mls_number,
                days_on_market=days_on_market,
                price_per_sqft=price_per_sqft,
                county=county
            )
            
        except Exception as e:
            print(f"  Warning: Error parsing row: {e}")
            return None
    
    def _record_to_tuple(self, record: PropertyRecord) -> tuple:
        """Convert PropertyRecord to tuple for insertion."""
        return (
            record.address,
            record.full_address,
            record.city,
            record.state,
            record.zip_code,
            record.latitude,
            record.longitude,
            record.beds,
            record.baths,
            record.sqft,
            record.year_built,
            record.price,
            record.sold_date,
            record.address_hash,
            record.smart_score,
            record.property_type,
            record.lot_size,
            record.hoa_month,
            record.url,
            record.mls_number,
            record.days_on_market,
            record.price_per_sqft,
            record.county
        )
    
    def _check_existing_hashes(self, hashes: List[str]) -> Set[str]:
        """Check which hashes already exist in database."""
        if not hashes:
            return set()
        
        existing = set()
        # Check in batches to avoid query size limits
        batch_size = 1000
        for i in range(0, len(hashes), batch_size):
            batch = hashes[i:i + batch_size]
            placeholders = ','.join(['%s'] * len(batch))
            query = f"SELECT address_hash FROM properties WHERE address_hash IN ({placeholders})"
            self.cursor.execute(query, batch)
            existing.update(row[0] for row in self.cursor.fetchall())
        
        return existing
    
    def insert_batch(self, records: List[PropertyRecord]):
        """Insert a batch of records into the database."""
        if not records:
            return
        
        # Check for existing records if skip_duplicates is enabled
        if self.skip_duplicates:
            hashes = [r.address_hash for r in records]
            existing_hashes = self._check_existing_hashes(hashes)
            
            new_records = [r for r in records if r.address_hash not in existing_hashes]
            skipped_count = len(records) - len(new_records)
            
            if skipped_count > 0:
                self.stats['records_skipped'] += skipped_count
                records = new_records
        
        if not records:
            return
        
        # Prepare insert query
        insert_sql = """
        INSERT INTO properties (
            address, full_address, city, state, zip_code,
            latitude, longitude, beds, baths, sqft,
            year_built, price, sold_date, address_hash, smart_score,
            property_type, lot_size, hoa_month, url, mls_number,
            days_on_market, price_per_sqft, county
        ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
        ON CONFLICT (address_hash) DO NOTHING
        """
        
        try:
            tuples = [self._record_to_tuple(r) for r in records]
            execute_batch(self.cursor, insert_sql, tuples, page_size=100)
            self.conn.commit()
            
            self.stats['records_inserted'] += len(records)
            self.stats['batches_executed'] += 1
            
        except Exception as e:
            self.conn.rollback()
            self.stats['records_failed'] += len(records)
            print(f"  Error inserting batch: {e}")
    
    def process_csv_file(self, filepath: Path):
        """Process a single CSV file."""
        print(f"\nProcessing: {filepath}")
        
        records = []
        line_count = 0
        
        with open(filepath, 'r', encoding='utf-8', errors='ignore') as f:
            reader = csv.DictReader(f)
            
            for row in reader:
                line_count += 1
                record = self._parse_redfin_csv_row(row)
                
                if record:
                    records.append(record)
                    
                    # Insert in batches
                    if len(records) >= self.batch_size:
                        self.insert_batch(records)
                        records = []
                        
                        if line_count % 5000 == 0:
                            print(f"  Processed {line_count} rows...")
        
        # Insert remaining records
        if records:
            self.insert_batch(records)
        
        self.stats['files_processed'] += 1
        self.stats['records_processed'] += line_count
        
        print(f"  ✓ Completed: {line_count} rows processed")
    
    def process_json_file(self, filepath: Path):
        """Process a single JSON file."""
        print(f"\nProcessing: {filepath}")
        
        with open(filepath, 'r', encoding='utf-8') as f:
            data = json.load(f)
        
        # Handle different JSON structures
        if isinstance(data, list):
            properties = data
        elif isinstance(data, dict):
            properties = data.get('properties', data.get('data', []))
        else:
            print(f"  ✗ Unknown JSON structure")
            return
        
        records = []
        for prop in properties:
            record = self._parse_redfin_csv_row(prop)
            if record:
                records.append(record)
            
            if len(records) >= self.batch_size:
                self.insert_batch(records)
                records = []
        
        if records:
            self.insert_batch(records)
        
        self.stats['files_processed'] += 1
        self.stats['records_processed'] += len(properties)
        
        print(f"  ✓ Completed: {len(properties)} properties processed")
    
    def process_directory(self, dirpath: Path):
        """Process all files in a directory."""
        csv_files = list(dirpath.glob("**/*.csv"))
        json_files = list(dirpath.glob("**/*.json"))
        
        print(f"\n{'='*60}")
        print(f"PROCESSING DIRECTORY: {dirpath}")
        print(f"{'='*60}")
        print(f"CSV files found: {len(csv_files)}")
        print(f"JSON files found: {len(json_files)}")
        
        # Process CSV files
        for filepath in csv_files:
            try:
                self.process_csv_file(filepath)
            except Exception as e:
                print(f"  ✗ Error processing {filepath}: {e}")
        
        # Process JSON files
        for filepath in json_files:
            try:
                self.process_json_file(filepath)
            except Exception as e:
                print(f"  ✗ Error processing {filepath}: {e}")
    
    def print_stats(self):
        """Print final statistics."""
        print(f"\n{'='*60}")
        print("DATABASE INSERTION STATISTICS")
        print(f"{'='*60}")
        print(f"Files processed: {self.stats['files_processed']}")
        print(f"Records processed: {self.stats['records_processed']}")
        print(f"Records inserted: {self.stats['records_inserted']}")
        print(f"Records skipped (duplicates): {self.stats['records_skipped']}")
        print(f"Records failed: {self.stats['records_failed']}")
        print(f"Batches executed: {self.stats['batches_executed']}")


def main():
    parser = argparse.ArgumentParser(
        description='Insert scraped properties into database',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog='''
Examples:
  # Insert from CSV file
  python insert_to_database.py --input data/scraped/properties_ca.csv
  
  # Insert from directory
  python insert_to_database.py --input data/scraped/by_zip
  
  # Insert with custom batch size
  python insert_to_database.py --input data/scraped --batch-size 500
  
  # Insert with custom database URL
  DATABASE_URL="postgresql://..." python insert_to_database.py --input data/scraped
        '''
    )
    
    parser.add_argument('--input', required=True,
                        help='Input file or directory path')
    parser.add_argument('--batch-size', type=int, default=1000,
                        help='Batch size for inserts (default: 1000)')
    parser.add_argument('--skip-duplicates', action='store_true', default=True,
                        help='Skip duplicate records based on address hash')
    
    args = parser.parse_args()
    
    input_path = Path(args.input)
    
    if not input_path.exists():
        print(f"Error: Input path does not exist: {input_path}")
        return
    
    # Initialize inserter
    inserter = DatabaseInserter(
        batch_size=args.batch_size,
        skip_duplicates=args.skip_duplicates
    )
    
    try:
        inserter.connect()
        
        if input_path.is_file():
            if input_path.suffix == '.csv':
                inserter.process_csv_file(input_path)
            elif input_path.suffix == '.json':
                inserter.process_json_file(input_path)
            else:
                print(f"Error: Unsupported file type: {input_path.suffix}")
        elif input_path.is_dir():
            inserter.process_directory(input_path)
        
        inserter.print_stats()
        
    except Exception as e:
        print(f"Error: {e}")
        raise
    finally:
        inserter.close()


if __name__ == '__main__':
    main()
