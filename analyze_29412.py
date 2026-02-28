
import pandas as pd
from datetime import datetime
import os

file_path = r'c:\Users\avion\OneDrive\Documents\GitHub\ghosteam\ghosteam-v5\firstknock-sales-os\master_after_recycling_blanks.csv'

if not os.path.exists(file_path):
    print(f"File not found: {file_path}")
    exit()

try:
    df = pd.read_csv(file_path)
    with open('analysis_result_utf8.txt', 'w', encoding='utf-8') as f:
        f.write(f"Columns: {df.columns.tolist()}\n")
        
        # Filter for 29412 - checking both 'zip_code' and 'address' if possible
        # We will cast to string and check for containment to be safe
        zip_matches = df[df.astype(str).apply(lambda x: x.str.contains('29412', case=False)).any(axis=1)]
        f.write(f"Total rows containing '29412': {len(zip_matches)}\n")

        # Try to find date column
        date_col = next((col for col in df.columns if 'date' in col.lower() or 'sold' in col.lower()), None)
        
        if date_col:
            f.write(f"Using date column: {date_col}\n")
            
            # Convert to datetime
            zip_matches[date_col] = pd.to_datetime(zip_matches[date_col], errors='coerce')
            
            # Filter for last 5 years (since Jan 1, 2021)
            recent_sales = zip_matches[zip_matches[date_col] >= '2021-01-01']
            f.write(f"Sales in 29412 since 2021: {len(recent_sales)}\n")
            
            # Group by year
            f.write("\nSales by Year:\n")
            f.write(recent_sales[date_col].dt.year.value_counts().sort_index().to_string())
        else:
            f.write("Could not identify a date column.\n")

except Exception as e:
    print(f"Error: {e}")
