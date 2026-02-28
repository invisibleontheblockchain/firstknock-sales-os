"""
Interactive Proxy Setup Wizard
==============================
Step-by-step guide to setting up proxies for high-speed scraping.

Run: python setup_proxies.py
"""

import os
import sys
from pathlib import Path


def print_header(text):
    """Print a formatted header."""
    print("\n" + "="*60)
    print(f"  {text}")
    print("="*60 + "\n")


def print_option(num, title, description, price):
    """Print a provider option."""
    print(f"{num}. {title}")
    print(f"   Cost: {price}")
    print(f"   {description}\n")


def get_input(prompt, default=None):
    """Get user input with optional default."""
    if default:
        prompt = f"{prompt} [{default}]: "
    else:
        prompt = f"{prompt}: "
    
    response = input(prompt).strip()
    return response if response else default


def setup_webshare():
    """Setup Webshare free proxies."""
    print_header("Webshare Setup (Free/Cheap)")
    
    print("""
Step 1: Create an account
  1. Go to https://www.webshare.io
  2. Click "Sign Up" (free)
  3. Verify your email

Step 2: Get your proxy credentials
  1. Go to Dashboard → Proxy List
  2. You'll see:
     - Proxy Address
     - Port  
     - Username
     - Password

Step 3: Enter your credentials below:
""")
    
    host = get_input("Proxy Address (host)", "p.webshare.io")
    port = get_input("Port", "80")
    username = get_input("Username")
    password = get_input("Password")
    
    proxy_line = f"http://{username}:{password}@{host}:{port}\n"
    
    # Save to file
    proxy_file = Path("proxies.txt")
    with open(proxy_file, 'w') as f:
        f.write("# Webshare Proxies\n")
        # Add multiple times for rotation
        for _ in range(20):
            f.write(proxy_line)
    
    print(f"\n✓ Proxies saved to {proxy_file.absolute()}")
    print(f"  Created 20 proxy entries for rotation")
    return proxy_file


def setup_brightdata():
    """Setup BrightData proxies."""
    print_header("BrightData Setup (Professional)")
    
    print("""
Step 1: Create an account
  1. Go to https://brightdata.com
  2. Start free trial or choose a plan
  3. Complete signup

Step 2: Create a proxy zone
  1. Go to "Proxy Infrastructure"
  2. Click "Add Zone"
  3. Choose:
     - Type: Residential
     - Network: Rotating (changes IP each request)
     - Format: Host:Port:Username:Password

Step 3: Get your credentials
  The format will be:
    Host: brd.superproxy.io
    Port: 22225
    Username: brd-customer-XXXX-zone-YOUR_ZONE
    Password: YOUR_PASSWORD

Step 4: Enter your credentials below:
""")
    
    host = get_input("Host", "brd.superproxy.io")
    port = get_input("Port", "22225")
    username = get_input("Username")
    password = get_input("Password")
    count = int(get_input("How many concurrent connections? (100 recommended)", "100"))
    
    proxy_file = Path("proxies.txt")
    with open(proxy_file, 'w') as f:
        f.write("# BrightData Proxies\n")
        f.write(f"# Zone: {username}\n\n")
        # Add multiple times for rotation
        for i in range(count):
            f.write(f"http://{username}:{password}@{host}:{port}\n")
    
    print(f"\n✓ Proxies saved to {proxy_file.absolute()}")
    print(f"  Created {count} proxy entries for {count} concurrent workers")
    return proxy_file


def setup_oxylabs():
    """Setup Oxylabs proxies."""
    print_header("Oxylabs Setup")
    
    print("""
Step 1: Create an account
  1. Go to https://oxylabs.io
  2. Choose Residential Proxies
  3. Sign up for a plan

Step 2: Get your credentials
  1. Go to Dashboard → Residential Proxies
  2. Create new user or use default
  3. Get:
     - Username
     - Password

Step 3: Enter your credentials below:
""")
    
    username = get_input("Username")
    password = get_input("Password")
    count = int(get_input("How many concurrent connections?", "100"))
    
    proxy_file = Path("proxies.txt")
    with open(proxy_file, 'w') as f:
        f.write("# Oxylabs Proxies\n")
        for i in range(count):
            f.write(f"http://{username}:{password}@residential.oxylabs.io:7777\n")
    
    print(f"\n✓ Proxies saved to {proxy_file.absolute()}")
    print(f"  Created {count} proxy entries")
    return proxy_file


def setup_manual():
    """Setup from existing proxy list."""
    print_header("Manual Proxy Setup")
    
    print("""
You already have proxies. Create a file named 'proxies.txt'
in this directory with one proxy per line.

Formats supported:
  192.168.1.1:8080
  http://192.168.1.1:8080
  http://user:pass@192.168.1.1:8080

Examples:
  203.0.113.1:8080
  203.0.113.2:8080
  http://myuser:mypass@proxy.example.com:3128
""")
    
    input("Press Enter when you've created proxies.txt...")
    
    proxy_file = Path("proxies.txt")
    if not proxy_file.exists():
        print("❌ proxies.txt not found!")
        return None
    
    # Count proxies
    with open(proxy_file, 'r') as f:
        lines = [l for l in f if l.strip() and not l.startswith('#')]
    
    print(f"✓ Found {len(lines)} proxies in {proxy_file.absolute()}")
    return proxy_file


def test_proxies(proxy_file):
    """Test the configured proxies."""
    print_header("Testing Proxies")
    print("Running proxy tests...\n")
    
    import subprocess
    result = subprocess.run([
        sys.executable,
        "proxy_manager.py",
        "--test-proxies", str(proxy_file),
        "--output", "working_proxies.txt"
    ], capture_output=False)
    
    if result.returncode == 0:
        working_file = Path("working_proxies.txt")
        if working_file.exists():
            with open(working_file, 'r') as f:
                count = len([l for l in f if l.strip() and not l.startswith('#')])
            print(f"\n✓ {count} working proxies saved to working_proxies.txt")
            return working_file
    
    return None


def show_next_steps(proxy_file):
    """Show what to do next."""
    print_header("Next Steps")
    
    print(f"""
Your proxies are configured! Now run the scraper:

1. Test with one state first (recommended):
   python county_batch_scraper.py --state CA --workers 50 --proxies {proxy_file}

2. If that works, run full scrape:
   python county_batch_scraper.py --workers 100 --proxies {proxy_file}

3. Monitor progress:
   python monitoring_dashboard.py --watch --data-dir data/scraped_counties

Expected completion time:
   - With 100 workers and good proxies: 10-30 minutes
   - With 50 workers: 20-60 minutes

Troubleshooting:
   - If you get blocked, increase delay: --delay 0.5
   - If proxies fail, test them: python proxy_manager.py --test-proxies {proxy_file}
   - Run without proxies (slower): python county_batch_scraper.py --workers 15
""")


def main():
    print_header("Proxy Setup Wizard")
    print("""
This wizard will help you set up proxies for high-speed scraping.
Proxies allow you to make many requests without getting blocked.

Estimated costs for full US scrape:
  - Free (Webshare): $0, but slower
  - Budget (PacketStream): ~$10-20
  - Professional (BrightData): ~$50-100

Without proxies, expect 2-4 hours to complete.
With proxies, expect 10-30 minutes to complete.
""")
    
    print("Choose a proxy provider:\n")
    print_option(1, "Webshare", "Free tier (10 proxies) or cheap paid plans. Good for testing.", "$0-20/month")
    print_option(2, "BrightData", "Best residential proxies, never get blocked.", "$50-500/month")
    print_option(3, "Oxylabs", "Good balance of price and quality.", "$30-300/month")
    print_option(4, "I already have proxies", "Use an existing proxy list.", "Varies")
    print_option(5, "Skip proxies", "Run without proxies (slower but free).", "$0")
    
    choice = get_input("Enter your choice (1-5)")
    
    if choice == "1":
        proxy_file = setup_webshare()
    elif choice == "2":
        proxy_file = setup_brightdata()
    elif choice == "3":
        proxy_file = setup_oxylabs()
    elif choice == "4":
        proxy_file = setup_manual()
    elif choice == "5":
        print("\n✓ You chose to run without proxies.")
        print("  The scraper will work but take 2-4 hours instead of 15-30 minutes.")
        print("\n  Run: python county_batch_scraper.py --workers 15")
        return
    else:
        print("Invalid choice")
        return
    
    if not proxy_file:
        return
    
    # Test proxies
    test = get_input("Test proxies now? (y/n)", "y")
    if test.lower() == "y":
        working_file = test_proxies(proxy_file)
        if working_file:
            proxy_file = working_file
    
    # Show next steps
    show_next_steps(proxy_file)
    
    print("\n" + "="*60)
    print("Setup complete! You're ready to scrape.")
    print("="*60 + "\n")


if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        print("\n\nSetup cancelled.")
        sys.exit(0)
