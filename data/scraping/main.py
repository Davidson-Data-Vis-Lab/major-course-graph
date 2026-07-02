import requests
from bs4 import BeautifulSoup

BASE_URL = "https://catalog.davidson.edu"
CATALOG_URL = f"{BASE_URL}/preview_program.php?catoid=28&poid=1795"


def get_soup(url):
    """
    Fetches the content of the given URL and returns a BeautifulSoup object.
    """
    print(f"Fetching {url}...")
    
    # More realistic headers
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
        "Accept-Encoding": "gzip, deflate",
        "DNT": "1",
        "Connection": "keep-alive",
        "Upgrade-Insecure-Requests": "1"
    }
    
    try:
        # Use session to maintain cookies
        session = requests.Session()
        resp = session.get(url, headers=headers, timeout=15)
        print(f"Status code: {resp.status_code}")
        print(f"Response length: {len(resp.text)} characters")
        print(f"First 500 chars:\n{resp.text[:500]}")
        
        resp.raise_for_status()
        return BeautifulSoup(resp.text, "html.parser")
    except requests.exceptions.RequestException as e:
        print(f"Request error: {e}")
        return None
    except Exception as e:
        print(f"Error: {e}")
        return None


def scrape_catalog(catalog_url):
    print("Starting scrape_catalog...")
    soup = get_soup(catalog_url)
    if soup is None:
        print("Failed to get soup")
        return
    print("Soup title: ", soup.title.string if soup.title else "No title found")
    

if __name__ == "__main__":
    print("Script started")
    scrape_catalog(CATALOG_URL)
    print("Script completed")