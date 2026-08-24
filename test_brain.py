from modules.brain import MockingbirdBrain

mockingbird = MockingbirdBrain()

response = mockingbird.think("Hello! What's your name?")
print(response)

print(mockingbird.clear_memory())