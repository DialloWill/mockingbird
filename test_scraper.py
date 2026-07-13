from modules.web_scraper import WebScraper

scraper = WebScraper()

print("Scraping example.com...")
data = scraper.scrape_website("https://example.com")

print("\n📄 Title:", data['title'])
print("\n📝 First paragraph:", data['paragraphs'][0] if data['paragraphs'] else "No paragraphs")
print("\n🔗 First link:", data['links'][0] if data['links'] else "No links")