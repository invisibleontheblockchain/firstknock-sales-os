import csv
import re
import requests
import time
from bs4 import BeautifulSoup

# Regex to find standard email formats
EMAIL_REGEX = r"[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-]+"

def get_company_domain(company_name):
    """
    Uses Clearbit's unauthenticated Autocomplete API to find a company's website 
    domain based on their name. This is faster and safer than scraping Google.
    """
    try:
        url = f"https://autocomplete.clearbit.com/v1/companies/suggest?query={requests.utils.quote(company_name)}"
        res = requests.get(url, timeout=5)
        if res.status_code == 200 and len(res.json()) > 0:
            return res.json()[0].get('domain')
    except Exception as e:
        pass
    return None

def scrape_emails_from_domain(domain):
    """
    Visits the homepage and the contact page of the domain to look for email addresses.
    """
    emails = set()
    urls_to_check = [
        f"https://{domain}", 
        f"https://{domain}/contact",
        f"https://{domain}/about-us"
    ]
    
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36"
    }
    
    for url in urls_to_check:
        try:
            res = requests.get(url, headers=headers, timeout=8)
            if res.status_code == 200:
                found = re.findall(EMAIL_REGEX, res.text)
                for email in found:
                    email = email.lower()
                    # Filter out common false positives (like images or wix generic emails)
                    if not email.endswith(('.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', 'sentry.io')):
                        # Filter out emails that start with numbers (usually not real contact emails)
                        if not re.match(r'^\d', email):
                            emails.add(email)
        except requests.exceptions.RequestException:
            continue # If a page doesn't exist or times out, just skip it
            
    return list(emails)

def main():
    input_file = 'companies.csv' # REPLACE with your actual input file name
    output_file = 'companies_with_emails_update.csv'
    
    # Read the companies
    companies_data = []
    with open(input_file, mode='r', encoding='utf-8') as f:
        reader = csv.DictReader(f)
        fieldnames = reader.fieldnames
        if 'email' not in fieldnames:
            fieldnames.append('email')
        if 'email_source' not in fieldnames:
            fieldnames.append('email_source')
            
        for row in reader:
            companies_data.append(row)
            
    print(f"Loaded {len(companies_data)} companies. Starting extraction...")

    # Open output file in write mode to save progressively
    with open(output_file, mode='w', encoding='utf-8', newline='') as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        
        for index, row in enumerate(companies_data):
            # Skip if an email already exists
            if row.get('email', '').strip():
                writer.writerow(row)
                continue
                
            company_name = row.get('company', '')
            if not company_name:
                writer.writerow(row)
                continue
                
            print(f"[{index+1}/{len(companies_data)}] Searching domain for: {company_name}")
            
            domain = get_company_domain(company_name)
            if domain:
                print(f"  -> Found domain: {domain}. Scraping for emails...")
                emails_found = scrape_emails_from_domain(domain)
                
                if emails_found:
                    # Pick the best email (prefer info@, support@, contact@ if multiple)
                    best_email = emails_found[0]
                    for e in emails_found:
                        if e.split('@')[0] in ['info', 'contact', 'hello', 'support', 'sales', 'team']:
                            best_email = e
                            break
                            
                    row['email'] = best_email
                    row['email_source'] = f"Scraped ({domain})"
                    print(f"  -> Found email: {best_email}")
                else:
                    print("  -> No emails found on website.")
            else:
                print("  -> Could not find a matching domain.")
                
            # Write immediately so progress is saved
            writer.writerow(row)
            
            # Sleep briefly to avoid aggressive rate-limiting
            time.sleep(1)

    print(f"Done! Results saved to {output_file}")

if __name__ == "__main__":
    main()
