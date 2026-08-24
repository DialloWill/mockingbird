# main.py
import os
from modules.brain import MockingbirdBrain
from modules.automation import ComputerController
from modules.web_scraper import WebScraper
from modules.web_driver import BrowserAutomation
from config.settings import GROQ_API_KEY

class MockingbirdBot:
    def __init__(self):
        """Initialize all Mockingbird components"""
        print("🤖 Initializing Mockingbird Bot...")
        
        self.brain = MockingbirdBrain()
        self.computer = ComputerController()
        self.scraper = WebScraper()
        self.browser = BrowserAutomation()
        
        print("✅ All systems online!")

    def start(self):
        """Start Mockingbird in interactive mode"""
        print("\n👋 Hello! I'm Mockingbird, your AI assistant.")
        print("Type 'exit' or 'quit' to stop.\n")
        
        while True:
            user_input = input("You: ").strip()
            
            if user_input.lower() in ['exit', 'quit', 'bye']:
                print("👋 Goodbye!")
                break

            if not user_input:
                continue
            
            response = self.process_command(user_input)
            print(f"\nMockingbird: {response}\n")

    def process_command(self, user_input):
        """Decide what to do with user's command"""
        command_lower = user_input.lower()
        
        if "screenshot" in command_lower:
            return self.computer.screenshot()
        
        elif "type" in command_lower and "write" not in command_lower:
            text = user_input.split("type", 1)[1].strip()
            return self.computer.type_text(text)
        
        elif "scrape" in command_lower or "extract" in command_lower:
            return "Please provide a URL to scrape."
        
        elif "open" in command_lower and "browser" in command_lower:
            return self.browser.start_browser()
        
        else:
            response = self.brain.think(user_input)
            return response

if __name__ == "__main__":
    mockingbird = MockingbirdBot()
    mockingbird.start()   
        