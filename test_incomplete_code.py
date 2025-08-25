#!/usr/bin/env python3
"""
Test file with incomplete code patterns for demonstrating 
NotImplementedError-focused suggestions
"""

class PaymentProcessor:
    def __init__(self):
        self.api_key = None
        
    def process_payment(self, amount, card_number):
        """Process a payment transaction"""
        # TODO: Add input validation
        raise NotImplementedError("Payment processing not yet implemented")
        
    def refund_payment(self, transaction_id):
        """Refund a payment"""
        # FIXME: This method needs proper implementation
        pass
        
    def get_transaction_history(self, user_id):
        """Get transaction history for a user"""
        # Placeholder implementation
        return None
        
    def validate_card(self, card_number):
        """Validate credit card number"""
        return
        
    def calculate_fees(self, amount):
        """Calculate processing fees"""
        # XXX: Fee calculation is hardcoded, needs dynamic pricing
        raise NotImplementedError()

class UserManager:
    def create_user(self, username, email):
        """Create a new user account"""
        # TODO: Implement user creation with validation
        pass
        
    def authenticate_user(self, username, password):
        """Authenticate user credentials"""
        # HACK: Always returns True for now
        return True
        
    def delete_user(self, user_id):
        """Delete a user account"""
        raise NotImplementedError("User deletion not implemented")

def send_notification(user_id, message):
    """Send notification to user"""
    # TODO: Implement email/SMS notification system
    pass

def generate_report():
    """Generate financial report"""
    # Placeholder: implement report generation
    return {}

# Empty function with no implementation
def backup_database():
    pass
