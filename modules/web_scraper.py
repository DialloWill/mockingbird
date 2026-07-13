import requests
from bs4 import BeautifulSoup
import json

class WebScraper:
    def __init__(self):
        self.headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
        }

        print("🌐 Web scraper initialized!")
    
    def scrape_website(self, url):
        try:
            response = requests.get(url, headers=self.headers)
            soup = BeautifulSoup(response.content, 'html.parser')
            
            data = {
                'title': soup.title.string if soup.title else 'No title',
                'paragraphs': [p.text for p in soup.find_all('p')[:5]],
                'links': [a.get('href') for a in soup.find_all('a')[:10]]
            }

            return data
            
        except Exception as e:
            return {'error': str(e)}
    
    def save_data(self, data, filename):
        with open(f"data/scraped_data/{filename}", 'w') as f:
            json.dump(data, f, indent=2)
        return f"Data saved to: {filename}"