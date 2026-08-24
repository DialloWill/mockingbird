from groq import Groq
from config.settings import GROQ_API_KEY, MODEL_NAME

class MockingbirdBrain:
    def __init__(self):
        self.client = Groq(api_key=GROQ_API_KEY)
        self.conversation_history = []
        print("🧠 Mockingbird brain initialized!")
    
    def think(self, user_input):
        try:
            self.conversation_history.append({
                "role": "user",
                "content": user_input
            })
            
            response = self.client.chat.completions.create(
                model=MODEL_NAME,
                messages=self.conversation_history,
                max_tokens=1000,
                temperature=0.7
            )

            assistant_message = response.choices[0].message.content

            self.conversation_history.append({
                "role": "assistant",
                "content": assistant_message})
            
            return assistant_message
        except Exception as e:
            return f"Error in brain processing: {str(e)}"
        
    def clear_memory(self):
        self.conversation_history = []
        return "🧠 Memory cleared!"